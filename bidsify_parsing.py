import os
import re
from os.path import basename, dirname, join, exists

import mne
from mne_bids import BIDSPath

from bidsify_constants import (
    PROC_PATTERNS,
    NOISE_PATTERNS,
    HEADPOS_PATTERNS,
    OPM_EXEPCIONS_PATTERNS,
    DERIVATIVES_SUBFOLDER,
)
from bidsify_utils import file_contains

mne.set_log_level('WARNING')


def extract_info_from_filename(file_name: str):
    """
    Parse MEG filenames to extract standardized metadata components.
    """
    suffix = ''
    desc = ''
    proc = ['']
    split = ''
    datatypes = ['']
    extension = ''

    participant = re.search(r'(NatMEG_|sub-)(\d+)', file_name).group(2).zfill(4)

    if len(participant.lstrip('0')) < 3:
        participant = participant.lstrip('0').zfill(3)
    extension = '.' + re.search(r'\.(.*)', basename(file_name)).group(1)
    datatypes = list(set([r.lower() for r in re.findall(r'(meg|raw|opm|eeg|behav)', basename(file_name), re.IGNORECASE)] +
                         ['opm' if 'kaptah' in file_name else '']))
    suffix = 'meg' if any(item in datatypes for item in ['raw', 'meg']) else ''
    datatypes = [d for d in datatypes if d != '']

    proc = re.findall('|'.join(PROC_PATTERNS), basename(file_name))

    if file_contains(basename(file_name), ['trans']):
        desc = 'trans'
        suffix = 'meg'

    if file_contains(file_name, HEADPOS_PATTERNS):
        suffix = 'headshape'

    split = re.search(r'(\-\d+\.fif)', basename(file_name))
    split = split.group(1).strip('.fif') if split else ''

    exclude_from_task = '|'.join(['NatMEG_'] + ['sub-'] + ['proc'] + datatypes + [participant] + [extension] + [suffix] + HEADPOS_PATTERNS + proc + [split] + ['\\+'] + ['\\-'] + [desc])

    if file_contains(file_name, OPM_EXEPCIONS_PATTERNS):
        datatypes.append('opm')

    if 'opm' in datatypes or 'kaptah' in file_name:
        exclude_from_task = '|'.join(['NatMEG_'] + ['sub-'] + ['proc-'] + datatypes + [participant] + [extension] + proc + [split] + ['\\+'] + ['\\-'] + ['file'] + [desc] + [r'\d{8}_', r'\d{6}_'])
        if not file_contains(file_name, OPM_EXEPCIONS_PATTERNS):
            exclude_from_task += '|hpi|ds'

        task = re.sub(exclude_from_task, '', basename(file_name), flags=re.IGNORECASE)
        proc = re.findall('|'.join(PROC_PATTERNS + ['hpi', 'ds']), basename(file_name))
    else:
        task = re.sub(exclude_from_task, '', basename(file_name), flags=re.IGNORECASE)

    task = [t for t in task.split('_') if t]
    if len(task) > 1:
        task = ''.join([t.title() for t in task])
    else:
        task = task[0]

    if file_contains(task, NOISE_PATTERNS):
        try:
            task = f"Noise{re.search('before|after', task.lower()).group().title()}"
        except Exception:
            task = 'Noise'

    info_dict = {
        'filename': file_name,
        'participant': participant,
        'task': task,
        'split': split,
        'processing': proc,
        'description': desc,
        'datatypes': datatypes,
        'suffix': suffix,
        'extension': extension
    }

    return info_dict


def get_split_file_parts(file_path):
    """
    Get all parts of a potentially split .fif file following MNE naming convention.
    """
    file_path_str = str(file_path)

    if not exists(file_path_str):
        return file_path_str

    parts = []
    base_path = re.sub(r'-\d+\.fif$', '.fif', file_path_str)

    if exists(base_path) and base_path != file_path_str:
        parts.append(base_path)
    else:
        parts.append(file_path_str)

    base_without_ext = base_path.replace('.fif', '')
    i = 1
    while True:
        split_file = f"{base_without_ext}-{i}.fif"
        if exists(split_file):
            parts.append(split_file)
            i += 1
        else:
            break

    if len(parts) == 1:
        return parts[0]
    return parts


def bids_path_from_rawname(file_name, date_session, config, pmap=None, read_info=True):
    """
    Extract BIDS path from filename using config and optional participant mapping.
    """
    if not exists(file_name):
        print(f"Not exists: {file_name}")
        return None

    bids_root = config.get('BIDS', '')
    info_dict = extract_info_from_filename(file_name)

    task = info_dict.get('task')
    subject = info_dict.get('participant')
    if not task or not subject:
        print(f"Missing required fields in {file_name}")
        return None

    acquisition = basename(dirname(file_name))

    proc = '+'.join(info_dict.get('processing', []))
    if proc:
        bids_root = join(bids_root, DERIVATIVES_SUBFOLDER)

    split = info_dict.get('split')
    run = info_dict.get('run', '')
    desc = info_dict.get('description')
    extension = info_dict.get('extension')
    suffix = info_dict.get('suffix')

    subj_out = subject
    session_out = str(date_session).replace('ses-', '')
    session_out = session_out.lstrip('0').zfill(2) if len(session_out) > 1 else session_out.zfill(2)

    if pmap is not None:
        old_subj_id = config.get('Original_subjID_name', '')
        new_subj_id = config.get('New_subjID_name', '')
        old_session = config.get('Original_session_name', '')
        new_session = config.get('New_session_name', '')

        check_subj = subject in pmap[old_subj_id].values
        check_date = date_session in pmap.loc[pmap[old_subj_id] == subject, old_session].values

        if not all([check_subj, check_date]):
            print('Not mapped participant/session')
            return None

        subj_out = str(pmap.loc[pmap[old_subj_id] == subject, new_subj_id].values[0]).zfill(3)
        session_out = str(pmap.loc[pmap[old_session] == date_session, new_session].values[0]).zfill(2)

    datatype = 'meg'
    if not read_info:
        if 'eeg' in info_dict.get('datatypes', []):
            datatype = 'eeg'
            extension = ''
            suffix = 'eeg'
    if read_info and not file_contains(basename(file_name), HEADPOS_PATTERNS + ['trans']):
        try:
            info = mne.io.read_info(file_name, verbose='error')
            ch_types = set(info.get_channel_types())

            if 'mag' in ch_types:
                datatype = 'meg'
                extension = '.fif'
            elif 'eeg' in ch_types:
                datatype = 'eeg'
                extension = ''
                suffix = 'eeg'
        except Exception as e:
            print(f"Error reading file {file_name}: {e}")

    try:
        bids_path = BIDSPath(
            root=bids_root,
            subject=subj_out,
            session=session_out,
            task=task,
            acquisition=acquisition,
            processing=None if proc == '' else proc,
            run=None if run == '' else str(run).zfill(2),
            datatype=datatype,
            description=None if desc == '' else desc,
            extension=None if extension == '' else extension,
            suffix=None if suffix == '' else suffix
        )
    except ValueError as e:
        print(f"Error creating BIDSPath for {file_name}: {e}")
        return None

    return bids_path, info_dict
