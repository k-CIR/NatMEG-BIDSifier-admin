import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from glob import glob
from os.path import basename, dirname, exists, getsize, join

import mne
import pandas as pd
from bids_validator import BIDSValidator
from mne_bids import BIDSPath, write_raw_bids, get_bids_path_from_fname
from mne_bids import write_meg_calibration, write_meg_crosstalk
from tqdm import tqdm

from bidsify_constants import HEADPOS_PATTERNS
from bidsify_conversion_table import load_conversion_table, update_conversion_table
from bidsify_parsing import bids_path_from_rawname, get_split_file_parts
from bidsify_sidecars import add_channel_parameters, copy_eeg_to_meg
from bidsify_templates import create_dataset_description, create_proc_description
from bidsify_utils import setLogPath

mne.set_log_level('WARNING')


def bidsify(config: dict, force_scan: bool = False, conversion_table=None, conversion_file=None):
    """
    Main function to convert raw MEG/EEG data to BIDS format.
    """
    ts = datetime.now().strftime('%Y%m%d')
    path_project = join(config.get('Root', ''), config.get('Name', ''))
    local_path = config.get('Raw', '')
    path_BIDS = config.get('BIDS', '')
    calibration = config.get('Calibration', '')
    crosstalk = config.get('Crosstalk', '')
    overwrite = config.get('overwrite', False)
    logfile = config.get('Logfile', '')
    participant_mapping = join(path_project, config.get('Participants_mapping_file', ''))
    logPath = setLogPath(config)

    if conversion_table is None or conversion_file is None:
        df, conversion_file, _ = update_conversion_table(config, force_scan=force_scan)
    else:
        df = conversion_table

    if df.empty or not conversion_file:
        print("Conversion table empty or not defined")
        return

    df = df.where(pd.notnull(df) & (df != ''), None)

    pmap = None
    if participant_mapping:
        try:
            pmap = pd.read_csv(participant_mapping, dtype=str)
        except Exception:
            print('Participant file not found, skipping')

    unique_participants_sessions = df[['participant_to', 'session_to', 'datatype']].drop_duplicates()
    for _, row in unique_participants_sessions.iterrows():
        if len(str(row['participant_to']).lstrip('0')) >= 3:
            subject_padded = str(row['participant_to']).zfill(4)
        else:
            subject_padded = str(row['participant_to']).lstrip('0').zfill(3)
        session_padded = str(row['session_to']).zfill(2)
        bids_path = BIDSPath(
            subject=subject_padded,
            session=session_padded,
            datatype=row['datatype'],
            root=path_BIDS
        ).mkdir()
        try:
            if row['datatype'] == 'meg':
                if not bids_path.meg_calibration_fpath:
                    write_meg_calibration(calibration, bids_path)
                if not bids_path.meg_crosstalk_fpath:
                    write_meg_crosstalk(crosstalk, bids_path)
        except Exception as e:
            print(f"Error writing calibration/crosstalk files: {e}")

    deviants = df[df['status'] == 'check']
    if len(deviants) > 0:
        print('Deviant tasks found, please check the conversion table and run again')
        df.to_csv(conversion_file, sep='\t', index=False)
        return

    if overwrite:
        process_mask = pd.Series([True] * len(df), index=df.index)
    else:
        process_mask = ~df['status'].isin(['processed', 'skip', 'missing'])

    status_counts = df['status'].fillna('').value_counts().to_dict()
    n_files_to_process = int(process_mask.sum())
    print(
        "Run summary: total={total} to_process={to_process} run={run} check={check} processed={processed} skip={skip} missing={missing} error={error}".format(
            total=len(df),
            to_process=n_files_to_process,
            run=status_counts.get('run', 0),
            check=status_counts.get('check', 0),
            processed=status_counts.get('processed', 0),
            skip=status_counts.get('skip', 0),
            missing=status_counts.get('missing', 0),
            error=status_counts.get('error', 0)
        )
    )
    if not overwrite and n_files_to_process == 0:
        print("No files marked 'run' to convert. Exiting bidsify process.")
        return

    pbar = tqdm(
        total=n_files_to_process,
        desc="Bidsify files",
        unit=" file(s)",
        disable=not sys.stdout.isatty(),
        ncols=80,
        bar_format='{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}]'
    )
    pcount = 0
    for i, d in df[process_mask].iterrows():
        try:
            pcount += 1
            print(f"Processing file {pcount}/{n_files_to_process} [{d['status']}]: {d['raw_name']}")
            pbar.update(1)

            bids_path = None

            raw_file = f"{d['raw_path']}/{d['raw_name']}"

            bids_path, raw_info = bids_path_from_rawname(
                raw_file,
                d['session_from'],
                config,
                pmap
            )

            event_id = d['event_id']
            events = None
            run = None
            if d['run']:
                run = str(d['run']).zfill(2)

            if event_id:
                with open(f"{path_BIDS}/../{event_id}", 'r') as f:
                    event_id = json.load(f)
                events = mne.find_events(raw)

            bids_path.update(
                subject=subject_padded,
                session=str(d['session_to']).zfill(2),
                task=d['task'],
                acquisition=d['acquisition'],
                processing=d['processing'],
                description=d['description'],
                run=run
            )

            if bids_path.description and 'trans' in bids_path.description:
                trans = mne.read_trans(raw_file, verbose='error')
                mne.write_trans(bids_path, trans, overwrite=True)

            elif bids_path.suffix and 'headshape' in bids_path.suffix:
                headpos = mne.chpi.read_head_pos(raw_file)
                mne.chpi.write_head_pos(bids_path, headpos)

            elif bids_path.datatype in ['meg', 'eeg']:
                try:
                    raw = mne.io.read_raw_fif(raw_file, allow_maxshield=True, verbose='error')
                    write_raw_bids(
                        raw=raw,
                        bids_path=bids_path,
                        empty_room=None,
                        event_id=event_id,
                        events=events,
                        overwrite=True,
                        verbose='error'
                    )

                    if bids_path.processing:
                        json_path = bids_path.copy().update(extension='.json', split=None)
                        if not exists(json_path.fpath):
                            print(f"Creating missing JSON sidecar: {json_path.basename}")
                            sidecar_data = {
                                'TaskName': bids_path.task,
                                'SamplingFrequency': raw.info['sfreq'],
                                'PowerLineFrequency': raw.info['line_freq'],
                                'Manufacturer': 'Elekta'
                            }
                            with open(json_path.fpath, 'w') as f:
                                json.dump(sidecar_data, f, indent=4)

                except Exception as e:
                    print(f"Error writing BIDS file: {e}")
                    fname = bids_path.copy().update(suffix='meg', extension='.fif').fpath
                    try:
                        raw.save(fname, overwrite=True, verbose='error')
                    except Exception as e:
                        print(f"Error saving raw file: {e}")

                if bids_path.datatype == 'eeg':
                    copy_eeg_to_meg(raw_file, bids_path)

            elif bids_path.acquisition == 'hedscan' and not bids_path.processing:
                opm_tsv = f"{d['raw_path']}/{d['raw_name']}".replace('raw.fif', 'channels.tsv')

                bids_tsv = bids_path.copy().update(suffix='channels', extension='.tsv')
                add_channel_parameters(bids_tsv, opm_tsv)

            df.at[i, 'status'] = 'processed'
            # Record successful processing
            from bidsify_conversion_table import _record_processing_success
            df = _record_processing_success(df, i)

        except Exception as e:
            print(f"Error processing file {d['raw_name']}: {e}")
            df.at[i, 'status'] = 'error'

        df.at[i, 'time_stamp'] = ts
        df.at[i, 'bids_path'] = dirname(bids_path)
        df.at[i, 'bids_name'] = basename(bids_path)
        df.to_csv(conversion_file, sep='\t', index=False)

    pbar.close()

    update_bids_report(df, config)
    print(f"All files bidsified according to {conversion_file}")


def consolidate_bids_report(report_file: str, config: dict):
    """
    Consolidate BIDS report by deduplicating entries.
    Keeps only the most recent entry (by timestamp) for each source→BIDS file pair.
    """
    if not exists(report_file):
        print(f"[INFO] Report file not found: {report_file}")
        return
    
    try:
        with open(report_file, 'r') as f:
            report_data = json.load(f)
            if isinstance(report_data, dict) and 'Report Table' in report_data:
                entries = report_data.get('Report Table', [])
            else:
                entries = report_data if isinstance(report_data, list) else []
    except (json.JSONDecodeError, FileNotFoundError):
        print(f"[ERROR] Could not read report file: {report_file}")
        return
    
    if not entries:
        print("[INFO] Report is empty, nothing to consolidate.")
        return
    
    def _entry_key(entry):
        return (entry.get('Source File', ''), entry.get('BIDS File', ''))
    
    # Keep most recent entry per source→BIDS pair
    consolidated = {}
    for entry in entries:
        key = _entry_key(entry)
        current_ts = entry.get('timestamp', '0000-00-00T00:00:00')
        
        if key not in consolidated or current_ts > consolidated[key].get('timestamp', '0000-00-00T00:00:00'):
            consolidated[key] = entry
    
    consolidated_entries = list(consolidated.values())
    removed_count = len(entries) - len(consolidated_entries)
    
    if removed_count == 0:
        print("[INFO] No duplicate entries found in report.")
        return
    
    # Write consolidated report
    try:
        with open(report_file, 'r') as f:
            report_data = json.load(f)
    except Exception:
        report_data = {}
    
    report_data['Report Table'] = consolidated_entries
    
    try:
        with open(report_file, 'w') as f:
            json.dump(report_data, f, indent=4, allow_nan=False)
        print(f"[INFO] Report consolidated: removed {removed_count} duplicate entries, kept {len(consolidated_entries)}")
    except Exception as e:
        print(f"[ERROR] Failed to write consolidated report: {e}")


def prune_bids_report(report_file: str, config: dict):
    """
    Prune BIDS report by removing entries where the raw source file no longer exists.
    """
    if not exists(report_file):
        print(f"[INFO] Report file not found: {report_file}")
        return
    
    try:
        with open(report_file, 'r') as f:
            report_data = json.load(f)
            if isinstance(report_data, dict) and 'Report Table' in report_data:
                entries = report_data.get('Report Table', [])
            else:
                entries = report_data if isinstance(report_data, list) else []
    except (json.JSONDecodeError, FileNotFoundError):
        print(f"[ERROR] Could not read report file: {report_file}")
        return
    
    if not entries:
        print("[INFO] Report is empty, nothing to prune.")
        return
    
    pruned_entries = []
    removed_count = 0
    
    for entry in entries:
        source_file = entry.get('Source File', '')
        if source_file and os.path.exists(source_file):
            pruned_entries.append(entry)
        else:
            removed_count += 1
    
    if removed_count == 0:
        print("[INFO] No missing source files found in report.")
        return
    
    # Write pruned report
    try:
        with open(report_file, 'r') as f:
            report_data = json.load(f)
    except Exception:
        report_data = {}
    
    report_data['Report Table'] = pruned_entries
    
    try:
        with open(report_file, 'w') as f:
            json.dump(report_data, f, indent=4, allow_nan=False)
        print(f"[INFO] Report pruned: removed {removed_count} entries for missing source files, kept {len(pruned_entries)}")
    except Exception as e:
        print(f"[ERROR] Failed to write pruned report: {e}")


def update_bids_report(conversion_table: pd.DataFrame, config: dict):
    """
    Update the BIDS results report with processed entries in JSON format.
    """
    bids_root = config.get('BIDS', '')
    logPath = setLogPath(config)
    report_file = os.path.join(logPath, 'bids_results.json')

    existing_report = []
    if exists(report_file):
        try:
            with open(report_file, 'r') as f:
                existing_report = json.load(f)
                if isinstance(existing_report, dict) and 'Report Table' in existing_report:
                    existing_report = existing_report.get('Report Table', [])
        except (json.JSONDecodeError, FileNotFoundError):
            existing_report = []

    def create_entry(source_file, destination_file, row):
        entry = {}
        bids_file = os.path.join(row['bids_path'].replace(config.get('BIDS', ''), ''), os.path.basename(destination_file))
        entry['Source File'] = source_file

        try:
            entry['Source Size'] = getsize(source_file) if exists(source_file) else 0
        except (OSError, FileNotFoundError):
            entry['Source Size'] = 0

        entry['BIDS File'] = destination_file

        try:
            if exists(destination_file):
                entry['BIDS Size'] = getsize(destination_file)
                entry['BIDS modification Date'] = datetime.fromtimestamp(os.path.getmtime(destination_file)).isoformat()
            else:
                entry['BIDS Size'] = 0
                entry['BIDS modification Date'] = 'Not yet created'
        except (OSError, FileNotFoundError):
            entry['BIDS Size'] = 0
            entry['BIDS modification Date'] = 'Not yet created'

        entry['Validated'] = 'True BIDS' if exists(destination_file) and BIDSValidator().is_bids(bids_file) else 'False BIDS'
        entry['Participant'] = row['participant_to']
        entry['Session'] = row['session_to']
        entry['Task'] = row['task']
        entry['Acquisition'] = row['acquisition']
        entry['Datatype'] = row['datatype']
        entry['Processing'] = row['processing'] if row['processing'] else 'N/A'
        entry['Splits'] = row['split'] if row['split'] else 'N/A'
        entry['Conversion Status'] = row['status']
        entry['timestamp'] = datetime.now().isoformat()

        return entry

    df = conversion_table.drop_duplicates(subset=['raw_path', 'raw_name', 'bids_path', 'bids_name'])
    df = df.where(pd.notnull(df) & (df != ''), None)
    for col in df.columns:
        if df[col].dtype != object:
            df[col] = df[col].astype(object)
    grouped_entries = []
    for i, row in df.iterrows():
        source_file = f"{row['raw_path']}/{row['raw_name']}"
        source_base = re.sub(r'_raw-\d+\.fif$', '.fif', source_file)

        bids_file_path = join(row['bids_path'], row['bids_name'])

        source_files = get_split_file_parts(source_base)
        destination_files = get_split_file_parts(bids_file_path)

        if not isinstance(source_files, list):
            source_files = [source_files]
        if not isinstance(destination_files, list):
            destination_files = [destination_files]

        for source_file, destination_file in zip(source_files, destination_files):
            grouped_entries.append(create_entry(source_file, destination_file, row))

    def _entry_key(entry):
        """Unique key: (source_file, bids_file)"""
        return (entry.get('Source File', ''), entry.get('BIDS File', ''))

    existing_keys = {_entry_key(e) for e in existing_report}
    new_entries = []
    updated_entries = []
    
    for entry in grouped_entries:
        key = _entry_key(entry)
        if key not in existing_keys:
            new_entries.append(entry)
        else:
            # Only update if status changed or file mtime is newer
            updated_entries.append(entry)
    
    # Replace existing entries with updated versions (newer file sizes, timestamps, status)
    for updated in updated_entries:
        key = _entry_key(updated)
        existing_report = [updated if _entry_key(e) == key else e for e in existing_report]

    if not new_entries and not updated_entries:
        print("[INFO] No new or updated entries to add to BIDS results report.")
        return 0

    final_report = {}
    participants_file = glob('participants.tsv', root_dir=bids_root)
    data_description_file = glob('dataset_description.json', root_dir=bids_root)
    try:
        conversion_status = 'Complete' if all(
            str(entry.get('Conversion Status', '')).lower() == 'processed' for entry in existing_report + new_entries
        ) else 'Incomplete'
    except Exception:
        conversion_status = 'Incomplete'

    final_report['BIDS Summary'] = {
        'Conversion Status': conversion_status,
        'Participants file': participants_file[0] if participants_file else 'Not found',
        'Data description': data_description_file[0] if data_description_file else 'Not found'
    }

    final_report['Report Table'] = existing_report + new_entries

    try:
        with open(report_file, 'w') as f:
            json.dump(final_report, f, indent=4, allow_nan=False)
        print(f"[INFO] BIDS results report written to: {report_file}")
    except Exception as e:
        print(f"[ERROR] Failed to write BIDS results report to {report_file}: {e}")

    print(f"BIDS report updated: {len(new_entries)} new entries, {len(updated_entries)} updated entries (total: {len(existing_report + new_entries)})")
    print(
        "[NOTE] Future improvements: support report consolidation (dedupe by source+bids), "
        "track processing dates per entry, option to prune old entries"
    )

    return len(new_entries) + len(updated_entries)


def args_parser():
    """
    Parse command-line arguments for bidsify script.
    """
    parser = argparse.ArgumentParser(
        description=(
            "\n"
            "BIDS Conversion Pipeline\n\n"
            "Main Operations:\n"
            "    --analyse  Only make or update the conversion table (no conversion)\n"
            "    --run      Execute the BIDS conversion pipeline (convert files)\n"
            "    --report   Generate BIDS report (JSON summary)\n\n"
            "Report Management:\n"
            "    --consolidate-report  Deduplicate entries in existing report\n"
            "    --prune-report        Remove entries for missing source files\n\n"
            "Arguments:\n"
            "    --config   Path to config file (YAML or JSON)\n"
            "    --reindex  Force full rescan of raw files (ignore cache)\n\n"
            "Viewer Pages:\n"
            "    Conversion Table:  [logs/bids_conversion.tsv]\n"
            "    BIDS Report:       [logs/bids_results.json]\n"
            "    Summary:           [logs/bids_results.json]\n"
            "    Editor:            [logs/bids_conversion.tsv] (editable)\n"
            "    Log:               [logs/bidsify.log]\n\n"
            "You can open these files from the Electron viewer's navigation menu.\n"
        ),
        add_help=True
    )
    parser.add_argument('--config', type=str, required=True, help='Path to config file (YAML or JSON)')
    parser.add_argument('--analyse', action='store_true', help='Make or update conversion table only')
    parser.add_argument('--run', action='store_true', help='Execute BIDS conversion pipeline')
    parser.add_argument('--report', action='store_true', help='Generate BIDS report (JSON summary)')
    parser.add_argument('--consolidate-report', action='store_true', help='Deduplicate entries in BIDS report')
    parser.add_argument('--prune-report', action='store_true', help='Remove entries for missing source files from report')
    parser.add_argument('--reindex', action='store_true', help='Force full rescan of raw files (ignore cache)')
    args = parser.parse_args()
    return args


def main(config: str = None):
    """
    Main entry point for BIDS conversion pipeline.
    """
    if config is None:
        args = args_parser()

        if args.config:
            config_file = args.config
        else:
            print('Use --config to specify a configuration file')
            sys.exit(1)

        if config_file:
            from bidsify_utils import get_parameters
            config = get_parameters(config_file)
        else:
            print('No configuration file selected')
            sys.exit(1)

    if isinstance(config, str):
        from bidsify_utils import get_parameters
        config = get_parameters(config)

    logPath = setLogPath(config)
    report_file = os.path.join(logPath, 'bids_results.json')

    if args.consolidate_report:
        print("Consolidating BIDS report (removing duplicates)")
        consolidate_bids_report(report_file, config)
        return True

    if args.prune_report:
        print("Pruning BIDS report (removing entries for missing source files)")
        prune_bids_report(report_file, config)
        return True

    if args.analyse:
        print("Generating conversion table only")
        conversion_table, conversion_file, run_conversion = update_conversion_table(config, force_scan=args.reindex)
        conversion_table.to_csv(conversion_file, sep='\t', index=False)
        print(f"Conversion table saved to: {conversion_file}")
        status_counts = conversion_table['status'].fillna('').value_counts().to_dict()
        total_rows = len(conversion_table)
        print(
            "Summary: total={total} run={run} check={check} processed={processed} skip={skip} missing={missing} error={error}".format(
                total=total_rows,
                run=status_counts.get('run', 0),
                check=status_counts.get('check', 0),
                processed=status_counts.get('processed', 0),
                skip=status_counts.get('skip', 0),
                missing=status_counts.get('missing', 0),
                error=status_counts.get('error', 0)
            )
        )

    if args.run:
        print("Running full BIDS conversion")
        create_dataset_description(config)
        create_proc_description(config)
        conversion_table, conversion_file = load_conversion_table(config, refresh_status=False)
        bidsify(config, force_scan=False, conversion_table=conversion_table, conversion_file=conversion_file)
        from bidsify_sidecars import update_sidecars
        update_sidecars(config)

    if args.report:
        print("Generating BIDS conversion report")
        update_bids_report(load_conversion_table(config, refresh_status=False)[0], config)

    return True


if __name__ == "__main__":
    main()
