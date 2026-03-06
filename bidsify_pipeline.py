import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from glob import glob
from typing import Dict, Any
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

# Import QA modules
try:
    from bidsify_qa_agent import BIDSQAAgent
    from bidsify_bids_schema import BIDSSchemaValidator
    QA_AVAILABLE = True
except ImportError:
    QA_AVAILABLE = False

mne.set_log_level('WARNING')


def bidsify(config: dict, conversion_table=None, conversion_file=None, force_scan: bool = False, verbose: bool = False):
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
        # Normalize participant ID: 1-99 → 012, 100-999 → 121, 1000+ → keep as is
        participant_str = str(row['participant_to'])
        if len(participant_str) >= 4:
            subject_padded = participant_str
        else:
            num = int(participant_str.lstrip('0') or '0')
            if num < 100:
                subject_padded = f"{num:03d}"
            else:
                subject_padded = str(num)
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

    df['status'] = df['status'].fillna('error')
    status_counts = df['status'].value_counts().to_dict()
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
            if verbose:
                print(f"Processing file {pcount}/{n_files_to_process} [{d['status']}]: {d['raw_name']}")
                print(f"  Raw file: {d['raw_path']}/{d['raw_name']}")
                print(f"  Participant: {d['participant_from']} -> {d['participant_to']}, Session: {d['session_from']} -> {d['session_to']}")
                print(f"  Task: {d['task']}, Acquisition: {d['acquisition']}, Processing: {d['processing']}, Description: {d['description']}, Run: {d['run']}")

            pbar.update(1)

            bids_path = None

            raw_file = f"{d['raw_path']}/{d['raw_name']}"

            bids_path, raw_info = bids_path_from_rawname(
                raw_file,
                d['session_from'],
                config,
                pmap
            )

            if verbose:
                print(f"  Initial BIDS path directory: {bids_path.directory}")
                print(f"  Initial BIDS path basename: {bids_path.basename}")

            event_id = d['event_id']
            events = None
            run = None
            if pd.notna(d['run']) and d['run'] != '':
                run = str(d['run']).zfill(2)

            if pd.notna(event_id) and event_id:
                with open(f"{path_BIDS}/../{event_id}", 'r') as f:
                    event_id = json.load(f)
                events = mne.find_events(raw)

            # Calculate subject_padded for THIS participant (not from the directory creation loop!)
            participant_str = str(d['participant_to'])
            if len(participant_str) >= 4:
                current_subject_padded = participant_str
            else:
                num = int(participant_str.lstrip('0') or '0')
                if num < 100:
                    current_subject_padded = f"{num:03d}"
                else:
                    current_subject_padded = str(num)

            if verbose:
                acq_val = None if pd.isna(d['acquisition']) or d['acquisition'] == '' else d['acquisition']
                proc_val = None if pd.isna(d['processing']) or d['processing'] == '' else d['processing']
                desc_val = None if pd.isna(d['description']) or d['description'] == '' else d['description']
                print(f"  Updating BIDS path with: subject={current_subject_padded}, task={d['task']}, run={run}, acq={acq_val}, proc={proc_val}, desc={desc_val}")

            bids_path.update(
                subject=current_subject_padded,
                session=str(d['session_to']).zfill(2),
                task=d['task'],
                acquisition=None if pd.isna(d['acquisition']) or d['acquisition'] == '' else d['acquisition'],
                processing=None if pd.isna(d['processing']) or d['processing'] == '' else d['processing'],
                description=None if pd.isna(d['description']) or d['description'] == '' else d['description'],
                run=run
            )

            if verbose:
                print(f"  Final BIDS path: {bids_path.fpath}")

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
            if verbose:
                import traceback
                print(f"  Exception details:")
                print(f"    Task: {d['task']}, Run: {d['run']}, Acquisition: {d['acquisition']}")
                print(f"    Processing: {d['processing']}, Description: {d['description']}")
                print(f"  Full traceback:")
                traceback.print_exc()
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

    def check_bids_file_issues(destination_file):
        """
        Check why a file might not be BIDS compliant.
        Returns reason string or None if valid.
        Reference: https://bids-standard.github.io/
        """
        if not exists(destination_file):
            return "File does not exist"
        
        issues = []
        
        # Check for missing sidecar JSON for MEG/EEG files
        if destination_file.endswith('_meg.fif') or destination_file.endswith('_eeg.fif'):
            sidecar_json = destination_file.replace('.fif', '.json')
            if not exists(sidecar_json):
                issues.append("Missing required JSON sidecar")
        
        # Check for missing calibration files for MEG
        if destination_file.endswith('_meg.fif'):
            base = destination_file.rsplit('_meg.fif', 1)[0]
            # MEG files should have associated _cal.dat and _ct.dat files (for Neuromag)
            has_quality_files = any(
                exists(base + suffix) 
                for suffix in ['_cal.dat', '_ct.dat', '_crosstalk.txt']
            )
            if not has_quality_files:
                issues.append("Missing MEG calibration/quality files (_cal.dat, _ct.dat)")
        
        # BIDSValidator check
        bids_file_rel = os.path.relpath(destination_file, bids_root)
        try:
            validator = BIDSValidator()
            if not validator.is_bids(bids_file_rel):
                if not issues:
                    issues.append("Does not meet BIDS specification requirements")
        except Exception as e:
            if not issues:
                issues.append(f"Validation error: {str(e)[:80]}")
        
        return "; ".join(issues) if issues else None

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

        is_valid = exists(destination_file) and BIDSValidator().is_bids(bids_file)
        entry['Validated'] = 'True BIDS' if is_valid else 'False BIDS'
        
        # Capture validation issue reason only for invalid files
        if not is_valid:
            entry['Validation Issue'] = check_bids_file_issues(destination_file)
        
        entry['Participant'] = row['participant_to'] if pd.notna(row['participant_to']) else 'N/A'
        entry['Session'] = row['session_to'] if pd.notna(row['session_to']) else 'N/A'
        entry['Task'] = row['task'] if pd.notna(row['task']) else 'N/A'
        entry['Acquisition'] = row['acquisition'] if pd.notna(row['acquisition']) and row['acquisition'] else 'N/A'
        entry['Datatype'] = row['datatype'] if pd.notna(row['datatype']) else 'N/A'
        entry['Processing'] = row['processing'] if pd.notna(row['processing']) and row['processing'] else 'N/A'
        entry['Splits'] = row['split'] if pd.notna(row['split']) and row['split'] else 'N/A'
        entry['Conversion Status'] = row['status'] if pd.notna(row['status']) else 'error'
        entry['timestamp'] = datetime.now().isoformat()
        
        # Action tracking for user annotations
        entry['BIDS action'] = ''  # Empty until user marks as OK, Ignored, etc.
        entry['action_timestamp'] = None
        entry['action_user_note'] = ''

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

    # Calculate BIDS compliance statistics
    all_entries = existing_report + new_entries
    total_files = len(all_entries)
    valid_bids = sum(1 for e in all_entries if e.get('Validated') == 'True BIDS')
    invalid_bids = sum(1 for e in all_entries if e.get('Validated') == 'False BIDS')
    
    # Aggregate validation issues
    validation_issues = {}
    for entry in all_entries:
        if entry.get('Validated') == 'False BIDS' and entry.get('Validation Issue'):
            issue = entry.get('Validation Issue')
            # Extract main issue type
            issue_type = issue.split(';')[0].strip()
            validation_issues[issue_type] = validation_issues.get(issue_type, 0) + 1
    
    compliance_summary = {
        'Conversion Status': conversion_status,
        'Total Files': total_files,
        'Valid BIDS Files': valid_bids,
        'Invalid BIDS Files': invalid_bids,
        'Compliance Rate (%)': round((valid_bids / total_files * 100) if total_files > 0 else 0, 1),
        'Participants file': participants_file[0] if participants_file else 'Not found',
        'Data description': data_description_file[0] if data_description_file else 'Not found'
    }
    
    if validation_issues:
        compliance_summary['Validation Issues'] = {
            'description': 'Common reasons for BIDS non-compliance. Reference: https://bids-standard.github.io/',
            'issues': validation_issues,
            'remediation': {
                'Missing required JSON sidecar': 'Ensure all MEG/EEG data files have corresponding .json metadata sidecars',
                'Missing MEG calibration/quality files': 'Check that calibration (_cal.dat), crosstalk (_ct.dat) files are present for Neuromag systems',
                'Does not meet BIDS specification': 'Check file naming conventions, required metadata fields, and dataset structure'
            }
        }
    
    final_report['BIDS Summary'] = compliance_summary

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


def run_qa_analysis(config: dict, conversion_table: pd.DataFrame = None) -> Dict[str, Any]:
    """
    Run QA analysis on completed BIDS dataset.
    Focuses on post-conversion validation and dataset-level consistency checks.
    
    Args:
        config: Configuration dictionary
        conversion_table: Optional conversion table for dataset-level checks
        
    Returns:
        QA results dictionary with findings, summary, and recommendations
    """
    if not QA_AVAILABLE:
        return {'error': 'QA modules not available'}
    
    path_BIDS = config.get('BIDS', '')
    if not exists(path_BIDS):
        return {'error': f'BIDS path not found: {path_BIDS}'}
    
    print("[INFO] Running post-conversion QA analysis...")
    
    try:
        agent = BIDSQAAgent(path_BIDS, config, enable_llm=False)  # Set to True if ollama is available
        results = agent.analyze_dataset(conversion_table)
        
        print(f"[INFO] QA analysis complete: {results['summary']['total_issues']} issues found")
        
        # Show brief summary
        if results['summary']['total_issues'] > 0:
            print(f"  - Errors: {results['summary']['severity_counts'].get('error', 0)}")
            print(f"  - Warnings: {results['summary']['severity_counts'].get('warning', 0)}")
            print(f"  - Info: {results['summary']['severity_counts'].get('info', 0)}")
        else:
            print("  ✓ No issues detected")
        
        return results
    except Exception as e:
        print(f"[ERROR] QA analysis failed: {e}")
        return {'error': str(e)}


def add_qa_to_report(config: dict, results_file: str, qa_results: Dict[str, Any]) -> None:
    """
    Add QA findings to existing results report JSON.
    
    Args:
        config: Configuration dictionary
        results_file: Path to bids_results.json
        qa_results: QA analysis results
    """
    if not exists(results_file) or not qa_results or 'error' in qa_results:
        return
    
    try:
        with open(results_file, 'r') as f:
            report = json.load(f)
    except json.JSONDecodeError:
        report = {}
    
    # Add QA section to report
    report['QA Analysis'] = {
        'timestamp': qa_results.get('timestamp', datetime.now().isoformat()),
        'summary': qa_results.get('summary', {}),
        'findings': qa_results.get('findings', []),
    }
    
    try:
        with open(results_file, 'w') as f:
            json.dump(report, f, indent=4, allow_nan=False)
        print(f"[INFO] QA results added to report: {results_file}")
    except Exception as e:
        print(f"[ERROR] Failed to write QA results to report: {e}")


def run_unified_validation(config: dict, conversion_table: pd.DataFrame = None) -> Dict[str, Any]:
    """
    Run unified BIDS validation combining file validation and dataset-level QA.
    Generates bids_validation.json with merged findings and action tracking.
    
    Args:
        config: Configuration dictionary
        conversion_table: Optional conversion table for dataset-level checks
        
    Returns:
        Unified validation results with merged findings and summary
    """
    bids_root = config.get('BIDS', '')
    logPath = setLogPath(config)
    validation_file = os.path.join(logPath, 'bids_validation.json')
    
    print("[INFO] Running unified BIDS validation analysis...")
    
    # Step 1: Run file validation (update report to get validation entries)
    print("  [1/3] Performing file validation...")
    if conversion_table is not None and not conversion_table.empty:
        update_bids_report(conversion_table, config)
    
    # Load file validation results
    report_file = os.path.join(logPath, 'bids_results.json')
    file_validation_entries = []
    file_validation_summary = {}
    
    if exists(report_file):
        try:
            with open(report_file, 'r') as f:
                report = json.load(f)
                file_validation_entries = report.get('Report Table', [])
                file_validation_summary = report.get('BIDS Summary', {})
                print(f"    ✓ File validation: {len(file_validation_entries)} files analyzed")
        except Exception as e:
            print(f"    ✗ Error reading file validation results: {e}")
    
    # Step 2: Run QA analysis
    print("  [2/3] Performing dataset QA analysis...")
    qa_results = run_qa_analysis(config, conversion_table)
    qa_findings = qa_results.get('findings', []) if 'findings' in qa_results else []
    qa_summary = qa_results.get('summary', {}) if 'summary' in qa_results else {}
    print(f"    ✓ QA analysis: {len(qa_findings)} dataset issues found")
    
    # Step 3: Merge findings and create unified report
    print("  [3/3] Merging findings and creating unified report...")
    
    # Convert file validation entries to unified format
    unified_entries = []
    for idx, file_entry in enumerate(file_validation_entries):
        entry = {
            'id': f"file-{idx}",
            'type': 'file_validation',
            'file': file_entry.get('BIDS File', ''),
            'source_file': file_entry.get('Source File', ''),
            'severity': 'error' if file_entry.get('Validated') == 'False BIDS' else 'info',
            'category': 'BIDS Compliance',
            'bids_level': 'file',
            'issue': file_entry.get('Validation Issue', 'N/A'),
            'validated': file_entry.get('Validated', 'N/A'),
            'conversion_status': file_entry.get('Conversion Status', ''),
            'participant': file_entry.get('Participant', ''),
            'session': file_entry.get('Session', ''),
            'task': file_entry.get('Task', ''),
            'datatype': file_entry.get('Datatype', ''),
            'acquisition': file_entry.get('Acquisition', ''),
            'bids_action': file_entry.get('BIDS action', ''),
            'action_timestamp': file_entry.get('action_timestamp'),
            'action_user_note': file_entry.get('action_user_note', ''),
            'last_checked': file_entry.get('timestamp', datetime.now().isoformat())
        }
        unified_entries.append(entry)
    
    # Add QA findings
    for idx, qa_entry in enumerate(qa_findings):
        qa_id_suffix = idx + len(file_validation_entries)
        entry = {
            'id': f"qa-{qa_id_suffix}",
            'type': 'dataset_issue',
            'file': qa_entry.get('file', ''),
            'severity': qa_entry.get('severity', 'info'),
            'category': qa_entry.get('category', 'Dataset Consistency'),
            'bids_level': qa_entry.get('bids_level', 'dataset'),
            'issue': qa_entry.get('issue', ''),
            'suggestion': qa_entry.get('suggestion', ''),
            'participant': qa_entry.get('participant', ''),
            'session': qa_entry.get('session', ''),
            'task': qa_entry.get('task', ''),
            'datatype': qa_entry.get('datatype', ''),
            'affected_fields': qa_entry.get('affected_fields', []),
            'bids_action': '',  # Empty until user takes action
            'action_timestamp': None,
            'action_user_note': '',
            'last_checked': qa_entry.get('timestamp', datetime.now().isoformat())
        }
        unified_entries.append(entry)
    
    # Create unified summary
    unified_summary = {
        'validation_timestamp': datetime.now().isoformat(),
        'dataset': bids_root,
        'conversion_status': file_validation_summary.get('Conversion Status', 'Unknown'),
        'file_validation': {
            'total_files': file_validation_summary.get('Total Files', 0),
            'valid_bids': file_validation_summary.get('Valid BIDS Files', 0),
            'invalid_bids': file_validation_summary.get('Invalid BIDS Files', 0),
            'compliance_rate': file_validation_summary.get('Compliance Rate (%)', 0),
            'issues_by_type': file_validation_summary.get('Validation Issues', {}).get('issues', {})
        },
        'qa_analysis': {
            'total_issues': qa_summary.get('total_issues', 0),
            'by_severity': qa_summary.get('severity_counts', {}),
            'by_category': qa_summary.get('category_counts', {})
        },
        'actions_tracking': {
            'total_entries': len(unified_entries),
            'entries_with_actions': sum(1 for e in unified_entries if e.get('bids_action'))
        },
        'participants_file': file_validation_summary.get('Participants file', 'Unknown'),
        'dataset_description': file_validation_summary.get('Data description', 'Unknown')
    }
    
    # Calculate overall status
    invalid_files = unified_summary['file_validation']['invalid_bids']
    error_issues = unified_summary['qa_analysis']['by_severity'].get('error', 0)
    warning_issues = unified_summary['qa_analysis']['by_severity'].get('warning', 0)
    
    if invalid_files > 0 or error_issues > 0:
        overall_status = f"Review Required - {invalid_files} file issues, {error_issues} errors"
    elif warning_issues > 0:
        overall_status = f"Warnings Present - {warning_issues} warnings"
    else:
        overall_status = "Validation Passed ✓"
    
    unified_summary['overall_status'] = overall_status
    
    # Write unified validation file
    validation_report = {
        'BIDS Validation Summary': unified_summary,
        'Validation Entries': unified_entries
    }
    
    try:
        with open(validation_file, 'w') as f:
            json.dump(validation_report, f, indent=4, allow_nan=False)
        print(f"[INFO] Unified validation report written to: {validation_file}")
    except Exception as e:
        print(f"[ERROR] Failed to write validation report: {e}")
        return {'error': str(e)}
    
    print(f"\n[SUMMARY] Validation complete:")
    print(f"  • Files: {file_validation_summary.get('Total Files', 0)} ({file_validation_summary.get('Compliance Rate (%)', 0)}% compliant)")
    print(f"  • Dataset issues: {qa_summary.get('total_issues', 0)} ({len([e for e in qa_findings if e.get('severity') == 'error'])} errors, {len([e for e in qa_findings if e.get('severity') == 'warning'])} warnings)")
    print(f"  • Status: {overall_status}\n")
    
    return validation_report


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
            "    --report   Generate BIDS report with QA analysis (JSON summary)\n"
            "    --qa       Run post-conversion QA analysis on completed dataset\n\n"
            "Report Management:\n"
            "    --consolidate-report  Deduplicate entries in existing report\n"
            "    --prune-report        Remove entries for missing source files\n\n"
            "Arguments:\n"
            "    --config   Path to config file (YAML or JSON)\n"
            "    --reindex  Force full rescan of raw files (ignore cache)\n\n"
            "Viewer Pages:\n"
            "    Conversion Table:  [logs/bids_conversion.tsv]\n"
            "    BIDS Report:       [logs/bids_results.json]\n"
            "    QA Analysis:       [logs/qa_analysis.json]\n"
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
    parser.add_argument('--report', action='store_true', help='Generate BIDS report with QA analysis (JSON summary)')
    parser.add_argument('--qa', action='store_true', help='Run post-conversion QA analysis on completed BIDS dataset')
    parser.add_argument('--validate', action='store_true', help='Run unified validation (file compliance + QA analysis) → bids_validation.json')
    parser.add_argument('--consolidate-report', action='store_true', help='Deduplicate entries in BIDS report')
    parser.add_argument('--prune-report', action='store_true', help='Remove entries for missing source files from report')
    parser.add_argument('--reindex', action='store_true', help='Force full rescan of raw files (ignore cache)')
    parser.add_argument('--verbose', action='store_true', help='Enable verbose output for debugging')
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
        conversion_table['status'] = conversion_table['status'].fillna('error')
        conversion_table.to_csv(conversion_file, sep='\t', index=False)
        print(f"Conversion table saved to: {conversion_file}")
        status_counts = conversion_table['status'].value_counts().to_dict()
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
        bidsify(config, force_scan=False, conversion_table=conversion_table, conversion_file=conversion_file, verbose=getattr(args, 'verbose', False))
        from bidsify_sidecars import update_sidecars
        update_sidecars(config)

    if args.report:
        print("Generating BIDS conversion report")
        conversion_table, _ = load_conversion_table(config, refresh_status=False)
        update_bids_report(conversion_table, config)
        
        # Add QA analysis to report
        qa_results = run_qa_analysis(config, conversion_table)
        if QA_AVAILABLE and 'error' not in qa_results:
            logPath = setLogPath(config)
            results_file = os.path.join(logPath, 'bids_results.json')
            add_qa_to_report(config, results_file, qa_results)

    if args.qa:
        print("Running post-conversion QA analysis")
        conversion_table, _ = load_conversion_table(config, refresh_status=False)
        qa_results = run_qa_analysis(config, conversion_table)
        
        # Save QA results to file
        if QA_AVAILABLE and 'error' not in qa_results:
            logPath = setLogPath(config)
            qa_file = os.path.join(logPath, 'qa_analysis.json')
            
            # Ensure log directory exists
            os.makedirs(logPath, exist_ok=True)
            
            try:
                with open(qa_file, 'w') as f:
                    json.dump(qa_results, f, indent=4, allow_nan=False)
                print(f"[INFO] QA analysis saved to: {qa_file}")
                
                # Verify file was created
                if os.path.exists(qa_file):
                    file_size = os.path.getsize(qa_file)
                    print(f"[INFO] QA file created successfully ({file_size} bytes)")
                else:
                    print(f"[ERROR] QA file was not created at: {qa_file}")
                
                # Print summary of findings by category
                if qa_results.get('summary', {}).get('categories'):
                    print("\n[INFO] Issues by category:")
                    for cat, count in sorted(qa_results['summary']['categories'].items()):
                        print(f"  - {cat}: {count}")
                else:
                    print("\n[INFO] No issues found by category analysis")
            except Exception as e:
                print(f"[ERROR] Failed to write QA analysis file: {e}")
                import traceback
                traceback.print_exc()
        else:
            if not QA_AVAILABLE:
                print("[WARN] QA analysis modules not available")
            elif 'error' in qa_results:
                print(f"[WARN] QA analysis returned error: {qa_results.get('error')}")
            else:
                print("[WARN] QA analysis failed or not available")

    if args.validate:
        print("Running unified BIDS validation analysis")
        conversion_table, _ = load_conversion_table(config, refresh_status=False)
        validation_results = run_unified_validation(config, conversion_table)
        
        if 'error' not in validation_results:
            logPath = setLogPath(config)
            validation_file = os.path.join(logPath, 'bids_validation.json')
            print(f"[INFO] Validation results saved to: {validation_file}")
        else:
            print(f"[WARN] Validation failed: {validation_results.get('error')}")

    return True


if __name__ == "__main__":
    main()
