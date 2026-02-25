import os
import time
import json
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from glob import glob
from os.path import dirname, join, getsize, getmtime

import pandas as pd

from bidsify_constants import OPM_EXEPCIONS_PATTERNS
from bidsify_parsing import bids_path_from_rawname, get_split_file_parts
from bidsify_utils import setLogPath

CONVERSION_COLUMNS = [
    'time_stamp',
    'status',
    'participant_from',
    'participant_to',
    'session_from',
    'session_to',
    'task',
    'split',
    'run',
    'datatype',
    'acquisition',
    'processing',
    'description',
    'raw_path',
    'raw_name',
    'bids_path',
    'bids_name',
    'event_id',
    'last_processed',
    'attempt_count',
    'status_history'
]


def _normalize_table(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=CONVERSION_COLUMNS)

    for col in CONVERSION_COLUMNS:
        if col not in df.columns:
            df[col] = None

    return df[CONVERSION_COLUMNS]


def _build_event_index(path_bids: str) -> dict:
    event_index = {}
    for event_file in glob('*_event_id.json', root_dir=f'{path_bids}/..'):
        task_name = event_file.replace('_event_id.json', '')
        event_index[task_name] = event_file
    return event_index


def _load_index(index_file: str) -> dict:
    if not os.path.exists(index_file):
        return {}
    try:
        df = pd.read_csv(index_file, sep='\t', dtype=str)
    except Exception:
        return {}

    index = {}
    for _, row in df.iterrows():
        key = f"{row['raw_path']}/{row['raw_name']}"
        index[key] = (row.get('mtime', ''), row.get('size', ''))
    return index


def _write_index(index_file: str, entries: list):
    df = pd.DataFrame(entries)
    df.to_csv(index_file, sep='\t', index=False)


def _file_signature(full_path: str) -> tuple:
    try:
        return str(getmtime(full_path)), str(getsize(full_path))
    except Exception:
        return '', ''


def _bids_output_exists(bids_path: str, bids_name: str) -> bool:
    if not bids_path or not bids_name:
        return False
    exact = join(bids_path, bids_name)
    if os.path.exists(exact):
        return True
    base, ext = os.path.splitext(bids_name)
    if base:
        # Fallback: allow any extension or sidecar for the same base name.
        pattern = join(bids_path, f"{base}.*")
        if glob(pattern):
            return True
    return False


def _initialize_tracking_fields(table: pd.DataFrame) -> pd.DataFrame:
    """Initialize tracking fields (last_processed, attempt_count, status_history) if missing."""
    if 'last_processed' not in table.columns:
        table['last_processed'] = None
    if 'attempt_count' not in table.columns:
        table['attempt_count'] = '0'
    if 'status_history' not in table.columns:
        table['status_history'] = None
    return table


def _update_status_with_history(table: pd.DataFrame, row_idx: int, new_status: str) -> pd.DataFrame:
    """Update status and record transition in status_history."""
    old_status = table.at[row_idx, 'status']
    table.at[row_idx, 'status'] = new_status
    
    if old_status != new_status:
        import json
        history_str = table.at[row_idx, 'status_history']
        try:
            history = json.loads(history_str) if history_str else []
        except (json.JSONDecodeError, TypeError):
            history = []
        
        history.append({
            'from': str(old_status) if pd.notna(old_status) else None,
            'to': new_status,
            'timestamp': datetime.now().isoformat()
        })
        table.at[row_idx, 'status_history'] = json.dumps(history)
    
    return table


def _record_processing_success(table: pd.DataFrame, row_idx: int) -> pd.DataFrame:
    """Update last_processed and increment attempt_count after successful processing."""
    table.at[row_idx, 'last_processed'] = datetime.now().isoformat()
    
    try:
        current_count = int(table.at[row_idx, 'attempt_count'] or '0')
    except (ValueError, TypeError):
        current_count = 0
    
    table.at[row_idx, 'attempt_count'] = str(current_count + 1)
    return table


def _refresh_processed_status(table: pd.DataFrame) -> pd.DataFrame:
    if table.empty:
        return table
    
    table = _initialize_tracking_fields(table)

    for i, row in table.iterrows():
        raw_path = row.get('raw_path')
        raw_name = row.get('raw_name')
        if raw_path and raw_name and not os.path.exists(join(raw_path, raw_name)):
            table = _update_status_with_history(table, i, 'missing')
            continue
        if row.get('status') in ['skip', 'check']:
            continue
        bids_path = row.get('bids_path')
        bids_name = row.get('bids_name')
        if _bids_output_exists(bids_path, bids_name):
            table = _update_status_with_history(table, i, 'processed')
        elif row.get('status') == 'processed':
            table = _update_status_with_history(table, i, 'run')
    return table


def generate_new_conversion_table(config: dict, existing_table: pd.DataFrame = None, force_scan: bool = False):
    """
    For each participant and session within MEG folder, generate conversion table entries.
    Uses parallel processing for efficiency and lightweight scans.
    """
    ts = datetime.now().strftime('%Y%m%d')
    path_project = join(config.get('Root', ''), config.get('Name', ''))
    path_raw = config.get('Raw', '')
    path_BIDS = config.get('BIDS', '')
    participant_mapping = join(path_project, config.get('Participants_mapping_file', ''))
    tasks = config.get('Tasks', []) + OPM_EXEPCIONS_PATTERNS

    processing_modalities = ['triux', 'hedscan']

    existing_table = _normalize_table(existing_table)
    processed_files = set()
    if not existing_table.empty:
        processed_files = set(
            existing_table.loc[(existing_table['status'] == 'processed') |
                                (existing_table['status'] == 'skip')]
            .apply(lambda row: f"{row['raw_path']}/{row['raw_name']}", axis=1)
        )

    pmap = None
    if participant_mapping:
        try:
            pmap = pd.read_csv(participant_mapping, dtype=str)
        except Exception:
            print('Participant mapping file not found, skipping')

    event_index = _build_event_index(path_BIDS)

    logPath = setLogPath(config)
    index_file = os.path.join(logPath, 'bids_conversion_index.tsv')
    previous_index = {} if force_scan else _load_index(index_file)
    new_index_entries = []

    def process_file_entry(job):
        participant, date_session, acquisition, file, sig, changed = job
        full_file_name = os.path.join(path_raw, participant, date_session, acquisition, file)
        if full_file_name in processed_files and not changed:
            if participant in glob('sub-*', root_dir=path_BIDS):
                return None

        bids_path, info_dict = bids_path_from_rawname(
            full_file_name,
            date_session,
            config,
            pmap,
            read_info=False
        )

        if info_dict['split']:
            return None
        split = None
        splits = get_split_file_parts(full_file_name)
        if isinstance(splits, list):
            split = str(len(splits) - 1)

        if not bids_path:
            return None

        task = bids_path.task
        run = bids_path.run
        datatype = bids_path.datatype
        proc = bids_path.processing
        desc = bids_path.description
        subj_out = bids_path.subject
        session_out = bids_path.session
        acquisition = bids_path.acquisition

        event_file = event_index.get(task) if task else None

        status = 'run'
        if task not in tasks + ['Noise']:
            status = 'check'

        if changed and status == 'processed':
            status = 'run'

        return {
            'time_stamp': ts,
            'status': status,
            'participant_from': participant,
            'participant_to': subj_out,
            'session_from': date_session,
            'session_to': session_out,
            'task': task,
            'split': split,
            'run': run,
            'datatype': datatype,
            'acquisition': acquisition,
            'processing': proc,
            'description': desc,
            'raw_path': dirname(full_file_name),
            'raw_name': file,
            'bids_path': bids_path.directory,
            'bids_name': bids_path.basename,
            'event_id': event_file,
            'last_processed': None,
            'attempt_count': '0',
            'status_history': None
        }

    jobs = []
    participants = glob('sub-*', root_dir=path_raw)
    for participant in participants:
        sessions = sorted([session for session in glob('*', root_dir=os.path.join(path_raw, participant))
                          if os.path.isdir(os.path.join(path_raw, participant, session))])
        for date_session in sessions:
            for acquisition in processing_modalities:
                all_files = sorted(
                    glob('*.fif', root_dir=os.path.join(path_raw, participant, date_session, acquisition)) +
                    glob('*.pos', root_dir=os.path.join(path_raw, participant, date_session, acquisition))
                )
                for file in all_files:
                    full_file_name = os.path.join(path_raw, participant, date_session, acquisition, file)
                    sig = _file_signature(full_file_name)
                    prev = previous_index.get(full_file_name)
                    changed = True if force_scan else prev != sig
                    new_index_entries.append({
                        'raw_path': dirname(full_file_name),
                        'raw_name': file,
                        'mtime': sig[0],
                        'size': sig[1]
                    })
                    jobs.append((participant, date_session, acquisition, file, sig, changed))

    max_workers = min(4, os.cpu_count() or 1)
    results = []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_file_entry, job): job for job in jobs}

        for future in as_completed(futures):
            try:
                result = future.result()
                if result is not None:
                    results.append(result)
            except Exception as e:
                job = futures[future]
                print(f"Error processing {job}: {e}")
                continue

    results.sort(key=lambda x: (x['participant_from'], x['session_from'], x['acquisition'], x['task'] or '', x['raw_name']))

    if new_index_entries:
        _write_index(index_file, new_index_entries)

    for result in results:
        yield result


def load_conversion_table(config: dict, refresh_status: bool = False):
    """
    Load or generate conversion table for BIDS conversion process.
    """
    overwrite = config.get('Overwrite_conversion', False)
    logPath = setLogPath(config)
    conversion_file = config.get('Conversion_file', 'bids_conversion.tsv')
    if conversion_file == '':
        conversion_file = 'bids_conversion.tsv'

    if not os.path.exists(logPath):
        os.makedirs(logPath, exist_ok=True)
        print(f"Created new log path: {logPath}")

    if not os.path.isabs(conversion_file):
        conversion_file = os.path.join(logPath, conversion_file)

    if not os.path.exists(dirname(conversion_file)):
        os.makedirs(dirname(conversion_file), exist_ok=True)
        print("No conversion logs directory found. Created new")

    if conversion_file and os.path.exists(conversion_file) and os.path.isfile(conversion_file) and not overwrite:
        try:
            if os.path.getsize(conversion_file) > 0:
                print(f"Loading conversion table from {conversion_file}")
                conversion_table = pd.read_csv(conversion_file, sep='\t', dtype=str)
                conversion_table = _normalize_table(conversion_table)
                if refresh_status:
                    conversion_table = _refresh_processed_status(conversion_table)
                return conversion_table, conversion_file
            else:
                print(f"Conversion file {conversion_file} is empty, generating new")
        except (pd.errors.EmptyDataError, ValueError):
            print(f"Conversion file {conversion_file} is corrupted or empty, generating new")
    else:
        if overwrite:
            print('Overwrite requested, generating new conversion table')
        elif not conversion_file:
            print('No conversion file specified, generating new')
        else:
            print(f'Conversion file {conversion_file} not found, generating new')

        results = list(generate_new_conversion_table(config))
        conversion_table = pd.DataFrame(results)
        conversion_table = _normalize_table(conversion_table)

        conversion_table.to_csv(conversion_file, sep='\t', index=False)
        print(f"New conversion table generated and saved to {os.path.basename(conversion_file)}")
        while not os.path.exists(conversion_file):
            time.sleep(0.5)

        conversion_files = sorted(
            glob(os.path.join(logPath, '*.tsv')),
            key=os.path.getctime
        )
        print(f"Found conversion files: {conversion_files}")
        if conversion_files:
            latest_conversion_file = conversion_files[-1]
            print(f"Loading the most recent conversion table: {os.path.basename(latest_conversion_file)}")
            try:
                if os.path.getsize(latest_conversion_file) > 0:
                    conversion_table = pd.read_csv(latest_conversion_file, sep='\t', dtype=str)
                    conversion_table = _normalize_table(conversion_table)
                    if refresh_status:
                        conversion_table = _refresh_processed_status(conversion_table)
                    return conversion_table, latest_conversion_file
                else:
                    print("Warning: Generated conversion table is empty. No files found to convert.")
                    return pd.DataFrame(columns=CONVERSION_COLUMNS), latest_conversion_file
            except (pd.errors.EmptyDataError, ValueError) as e:
                print(f"Warning: Generated conversion table is corrupted or empty: {e}")
                return pd.DataFrame(columns=CONVERSION_COLUMNS), latest_conversion_file
        else:
            raise FileNotFoundError("No conversion files found after generation")


def update_conversion_table(config, conversion_file=None, force_scan: bool = False):
    """
    Update conversion table to add new files not currently tracked.
    """
    existing_conversion_table, existing_conversion_file = load_conversion_table(config, refresh_status=True)
    if not conversion_file:
        conversion_file = existing_conversion_file

    results = list(generate_new_conversion_table(config, existing_conversion_table, force_scan=force_scan))
    new_conversion_table = pd.DataFrame(results)
    new_conversion_table = _normalize_table(new_conversion_table)

    run_conversion = True
    if new_conversion_table.empty:
        run_conversion = False
        print("No files found to add to conversion table.")
        return existing_conversion_table, conversion_file, run_conversion

    existing_conversion_table = _normalize_table(existing_conversion_table)
    existing_keys = set(
        existing_conversion_table.apply(lambda row: f"{row['raw_path']}/{row['raw_name']}", axis=1)
    )

    diff_rows = []
    for _, row in new_conversion_table.iterrows():
        key = f"{row['raw_path']}/{row['raw_name']}"
        if key not in existing_keys:
            diff_rows.append(row)

    if not diff_rows:
        run_conversion = False
        print("No new files to add to conversion table.")
        return existing_conversion_table, conversion_file, run_conversion

    diff = pd.DataFrame(diff_rows)
    if 'status' in diff.columns:
        diff.loc[diff['status'].isin(['processed', 'skip']), 'status'] = 'run'

    updated_table = pd.concat([existing_conversion_table, diff], ignore_index=True)

    print(f"Adding {len(diff)} new files to conversion table.")

    return updated_table, conversion_file, run_conversion
