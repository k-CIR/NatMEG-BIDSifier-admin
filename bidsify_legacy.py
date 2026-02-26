import pandas as pd
import math
import json
import yaml
import os
from shutil import copy2
import re
from copy import deepcopy
from os.path import exists, basename, dirname, join, getsize
import sys
from glob import glob
import numpy as np
import argparse
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import subprocess
from tqdm import tqdm

from mne_bids import (
    BIDSPath,
    write_raw_bids,
    read_raw_bids,
    update_sidecar_json,
    make_dataset_description,
    write_meg_calibration,
    write_meg_crosstalk,
    update_anat_landmarks,
    print_dir_tree,
    find_matching_paths,
    get_entities_from_fname,
    get_bids_path_from_fname
    )
from mne_bids.utils import _write_json
from mne_bids.write import _sidecar_json
import mne_bids
import mne
import time
from bids_validator import BIDSValidator # Not in use, yet
#from bids import BIDSLayout
mne.set_log_level('WARNING')

###############################################################################
# Variables
###############################################################################
EXCLUDE_PATTERNS = [r'-\d+\.fif', '_trans', 'avg.fif']
NOISE_PATTERNS = ['empty', 'noise', 'Empty']
HEADPOS_PATTERNS = ['headpos', 'headshape']
OPM_EXEPCIONS_PATTERNS = ['HPIbefore', 'HPIafter', 'HPImiddle', 'HPIpre', 'HPIpost']
PROC_PATTERNS = ['tsss', 'sss', r'corr\d+', r'ds\d+', 'mc', 'avgHead']

# Conversion table field descriptions for user guidance
CONVERSION_TABLE_FIELDS = {
    'time_stamp': 'Date when entry was created (YYYYMMDD)',
    'status': 'Processing status: check=needs review, run=ready to convert, processed=converted, skip=ignore, missing=raw file missing on disk',
    'participant_from': 'Original participant identifier from filename',
    'participant_to': 'Target BIDS participant ID (zero-padded)',
    'session_from': 'Original session identifier from filename', 
    'session_to': 'Target BIDS session ID (zero-padded)',
    'task': 'BIDS task name (EDITABLE - main field for manual changes)',
    'acquisition': 'MEG acquisition type (triux/hedscan)',
    'processing': 'Processing pipeline applied (hpi, sss, etc.)',
    'description': 'Additional BIDS description field',
    'datatype': 'BIDS datatype (meg/eeg)', 
    'split': 'Split file indicator for large files (auto-managed)',
    'run': 'BIDS run number for repeated acquisitions',
    'raw_path': 'Full path to source raw file directory',
    'raw_name': 'Source raw filename',
    'bids_path': 'Target BIDS directory path', 
    'bids_name': 'Target BIDS filename',
    'event_id': 'Associated event file for task'
}

DERIVATIVES_SUBFOLDER = 'derivatives/preprocessed-meg'

###############################################################################
# Utility functions
###############################################################################

def setLogPath(config: dict = None, LogPath: str = None):
    """_summary_
    
    Check config and set preferred logging location.
    LogPath overrides config setting if provided.

    Args:
        log_path (str): _description_
    """
    
    if LogPath:
        log_path = LogPath
        os.makedirs(log_path, exist_ok=True)
        return log_path

    # 1. Log path under project
    project_name = config.get('Name', {}) or config.get('name', {}) or ''
    root = config.get('Root', {}) or config.get('root', '') or ''
    
    # 1a. Check project root and name to not duplicate project name
    project_root = join(root, project_name) if project_name != basename(root) else root
    
    log_path = join(project_root, 'logs')
    
    # 2. if not log_path exists try via BIDS path
    if not log_path or not exists(log_path):
        path_BIDS = config.get('BIDS') or config.get('bids') or config.get('BIDSPath') or config.get('bids_path') or None    
        log_path = join(dirname(path_BIDS), 'logs') if path_BIDS else None
        
        if log_path and exists(log_path):
            # As a last resort, use ./logs in CWD and warn
            log_path = './logs'
            print(f"[WARN] Log path missing; falling back to log path: {log_path}")
            os.makedirs(log_path, exist_ok=True)
            return log_path

    os.makedirs(log_path, exist_ok=True)
    return log_path

def file_contains(file: str, pattern: list):
    """
    Check if filename contains any of the specified patterns using regex.
    
    Performs case-sensitive pattern matching against filename using compiled
    regular expressions for efficient multi-pattern searching.
    
    Args:
        file (str): Filename or path to check
        pattern (list): List of regex patterns to match against
    
    Returns:
        bool: True if any pattern matches, False otherwise
        
    Examples:
        >>> file_contains('test_tsss_mc.fif', PROC_PATTERNS)
        True
        >>> file_contains('empty_room.fif', NOISE_PATTERNS)
        True
        >>> file_contains('regular_data.fif', HEADPOS_PATTERNS)
        False
    
    Note:
        Patterns are joined with '|' (OR) operator for single regex compilation
    """
    return bool(re.compile('|'.join(pattern)).search(file))

def extract_info_from_filename(file_name: str):
    """
    Parse MEG filenames to extract standardized metadata components.
    
    Comprehensive filename parser that handles both TRIUX (NatMEG_) and 
    BIDS (sub-) naming conventions. Extracts participant IDs, task names,
    processing stages, data types, and file structure information using
    regex pattern matching.
    
    Supported Filename Formats:
    - TRIUX: NatMEG_001_TaskName_proc-options_meg.fif
    - BIDS: sub-001_ses-01_task-TaskName_proc-options_meg.fif
    - OPM: Various Kaptah-specific patterns
    
    Parsing Features:
    - Participant ID extraction (zero-padded numbers)
    - Task name identification with intelligent filtering
    - Processing stage detection (tSSS, SSS, movement correction, etc.)
    - Data type classification (MEG, EEG, OPM, behavioral)
    - Split file detection (-1.fif, -2.fif, etc.)
    - Head position file identification (trans, headpos)
    - Noise recording classification (empty room variants)
    
    Args:
        file_name (str): Full path or filename to parse
    
    Returns:
        dict: Parsed filename components with keys:
            - filename (str): Original input filename
            - participant (str): Participant ID (e.g., '001')
            - task (str): Task name (e.g., 'Phalanges', 'AudOdd')
            - split (str): Split file suffix (e.g., '-1', '-2') or empty
            - processing (list): Processing steps applied (e.g., ['tsss', 'mc'])
            - description (list): File type descriptors (e.g., ['trans', 'headpos'])
            - datatypes (list): Data modalities (e.g., ['meg', 'opm'])
            - suffix (str): Special suffix (e.g., 'headshape') or None
            - extension (str): File extension (e.g., '.fif')
    
    Special Handling:
    - OPM files: Uses position-based task extraction
    - Noise files: Standardizes to 'Noise', 'NoiseBefore', 'NoiseAfter'
    - Multi-word tasks: Converts to CamelCase (e.g., 'aud_odd' → 'AudOdd')
    - Split files: Preserves original numbering scheme
    
    Examples:
        >>> extract_info_from_filename('NatMEG_001_Phalanges_tsss_mc_meg.fif')
        {
            'filename': 'NatMEG_001_Phalanges_tsss_mc_meg.fif',
            'participant': '001',
            'task': 'Phalanges',
            'split': '',
            'processing': ['tsss', 'mc'],
            'description': [],
            'datatypes': ['meg'],
            'extension': '.fif'
        }
        
        >>> extract_info_from_filename('sub-001_task-empty_room_after.fif')
        {
            'filename': 'sub-001_task-empty_room_after.fif',
            'participant': '001', 
            'task': 'NoiseAfter',
            'split': '',
            'processing': [],
            'description': [],
            'datatypes': ['meg'],
            'extension': '.fif'
        }
    
    Note:
        Function handles edge cases and various naming inconsistencies
        commonly found in MEG datasets across different acquisition systems
    """
    suffix = ''
    desc = ''
    proc = ['']
    split = ''
    datatypes = ['']
    extension = ''
    
    # Extract participant, task, processing, datatypes and extension
    participant = re.search(r'(NatMEG_|sub-)(\d+)', file_name).group(2).zfill(4)

    if len(participant.lstrip('0')) <= 3:
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
    
    exclude_from_task = '|'.join(['NatMEG_'] + ['sub-'] + ['proc']+ datatypes + [participant] + [extension]  + [suffix] + HEADPOS_PATTERNS + proc + [split] + ['\\+'] + ['\\-'] + [desc])
    
    if file_contains(file_name, OPM_EXEPCIONS_PATTERNS):
        datatypes.append('opm')
    
    if 'opm' in datatypes or 'kaptah' in file_name:    

        exclude_from_task = '|'.join(['NatMEG_'] + ['sub-'] + ['proc-']+ datatypes + [participant] + [extension] + proc + [split] + ['\\+'] + ['\\-'] + ['file']+ [desc] + [r'\d{8}_', r'\d{6}_'])
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
            task = f'Noise{re.search("before|after", task.lower()).group().title()}'
        except:
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
    
    Args:
        file_path: File path (string or Path object)
        
    Returns:
        str or list: Single file path if no splits found, list of file paths if splits exist
    """
    file_path_str = str(file_path)
    
    # If the file doesn't exist and has no split pattern, return as-is
    if not exists(file_path_str):
        return file_path_str
    
    # Try the MNE convention with -1.fif, -2.fif, etc.
    # Look for split files: filename_raw-1.fif, filename_raw-2.fif, etc.
    parts = []
    base_path = re.sub(r'-\d+\.fif$', '.fif', file_path_str)
    
    # Check if the base file exists
    if exists(base_path) and base_path != file_path_str:
        parts.append(base_path)
    else:
        # No split suffix found, start with the original path
        parts.append(file_path_str)
    
    # Look for numbered splits: filename-1.fif, filename-2.fif, etc.
    base_without_ext = base_path.replace('.fif', '')
    i = 1
    while True:
        split_file = f"{base_without_ext}-{i}.fif"
        if exists(split_file):
            parts.append(split_file)
            i += 1
        else:
            break
    
    # Return single string if only one part, list if multiple
    if len(parts) == 1:
        return parts[0]
    else:
        return parts

###############################################################################
# Functions: Create or fill templates: dataset description, participants info
###############################################################################

def create_dataset_description(config: dict):
    """
    Create or update BIDS dataset_description.json file with metadata.
    
    Creates the BIDS root directory if it doesn't exist and generates a 
    dataset_description.json file with project metadata according to BIDS 
    specification.
    
    Args:
        config (dict): Configuration dictionary containing BIDS parameters
                      including dataset name, authors, funding, etc.
    
    Returns:
        None
    
    Side Effects:
        - Creates BIDS directory structure
        - Writes dataset_description.json file
        - Loads existing description data into memory
    """
    
    # Make sure the BIDS directory exists and create it if it doesn't
    # Get dataset description config or fall back to old structure
    dataset_desc = config.get('Dataset_description', {})
    bids_path = config.get('BIDS', {})
    os.makedirs(bids_path, exist_ok=True)
    
    # Define the path to the dataset_description.json file
    
    file_bids = f"{bids_path}/{dataset_desc}"

    # Create empty dataset description if not exists or overwrite is enabled
    if not exists(file_bids) or config.get('overwrite', False):
        make_dataset_description(
            path=bids_path,
            name=config.get('Name', config.get('Name', 'MEG Dataset')),
            dataset_type=config.get('DatasetType', config.get('dataset_type', 'raw')),
            data_license=config.get('License', config.get('data_license', '')),
            authors=config.get('Authors', config.get('authors', [])),
            acknowledgements=config.get('Acknowledgements', config.get('acknowledgements', '')),
            how_to_acknowledge=config.get('HowToAcknowledge', config.get('how_to_acknowledge', '')),
            funding=config.get('Funding', config.get('funding', [])),
            ethics_approvals=config.get('EthicsApprovals', config.get('ethics_approvals', [])),
            references_and_links=config.get('ReferencesAndLinks', config.get('references_and_links', [])),
            doi=config.get('DatasetDOI', config.get('doi', '')),
            overwrite=config.get('overwrite', False)
        )

        # Add GeneratedBy field manually if provided
        generated_by = config.get('GeneratedBy', None)
        if generated_by:
            import json
            with open(file_bids, 'r') as f:
                desc_data = json.load(f)
            desc_data['GeneratedBy'] = generated_by
            with open(file_bids, 'w') as f:
                json.dump(desc_data, f, indent=4)

def create_participants_files(config: dict):
    """
    Create BIDS participants.tsv and participants.json files with default structure.
    
    Generates template participant files with standard columns (participant_id, 
    sex, age, group) and corresponding JSON metadata file describing each field.
    
    Args:
        config (dict): Configuration dictionary with BIDS path and settings
    
    Returns:
        None
        
    Side Effects:
        - Creates participants.tsv with empty participant table
        - Creates participants.json with field descriptions
        - Prints creation messages
    """
    # check if participants.tsv and participants.json files is available or create a new one with default fields
    os.makedirs(config['BIDS'], exist_ok=True)
    
    participants_filename = config.get('Participants', 'participants.tsv')
    tsv_file = os.path.join(config['BIDS'], participants_filename)
    if not exists(tsv_file) or config.get('overwrite', False):
        # create default fields participants.tsv
        participants = glob('sub*', root_dir=config['BIDS'])
        # create empty table with 4 columns (participant_id, sex, age)
        df = pd.DataFrame(columns=['participant_id', 'sex', 'age', 'group'])
            
        participants_tsv_path = os.path.join(config['BIDS'], 'participants.tsv')
        df.to_csv(participants_tsv_path, sep='\t', index=False)
        print(f"Writing {participants_tsv_path}")

    json_file = os.path.join(config['BIDS'], 'participants.json')

    if not exists(json_file) or config.get('overwrite', False):
        participants_json = {
            "participant_id": {
                "Description": "Unique participant identifier"
            },
            "sex": {
                "Description": "Biological sex of participant. Self-rated by participant",
                "Levels": {
                    "M": "male",
                    "F": "female"
                }
            },
            "age": {
                "Description": "Age of participant at time of MEG scanning",
                "Units": "years"
            },
            "group": {
                "Description": "Group of participant. By default everyone is in control group",
            }
        }

    participants_json_path = os.path.join(config['BIDS'], 'participants.json')
    with open(participants_json_path, 'w') as f:
            json.dump(participants_json, f, indent=4)
    print(f"Writing {participants_json_path}")

def create_proc_description(config: dict):
    
    bids_root = config['BIDS']
    proc_root = join(config['BIDS'], DERIVATIVES_SUBFOLDER)
    os.makedirs(proc_root, exist_ok=True)
    
    proc_mapping = {
        'sss': 'Signal Space Separation (SSS) applied',
        'hpi': 'Digitized head position and HPI coils added',
        'ds': 'Downsampled data',
        'mc': 'Head motion correction applied',
        'avgHead': 'Data aligned to average head position',
        'corr': 'Correlation treashold applied',
        'tsss': 'Temporal Signal Space Separation (tSSS) applied',
    }
    df = pd.DataFrame(list(proc_mapping.items()), columns=['desc_id', 'description'])
    df.to_csv(join(proc_root, 'descriptions.tsv'), sep='\t', index=False)


###############################################################################
# Help functions
###############################################################################

def get_parameters(config):
    """
    Extract and merge BIDS configuration parameters from file or dictionary.
    
    Reads configuration from JSON/YAML file or processes existing dictionary,
    combining project and BIDS-specific parameters into a unified configuration.
    
    Args:
        config (str or dict): Path to config file (.json/.yml/.yaml) or 
                             configuration dictionary
    
    Returns:
        dict: Merged configuration dictionary combining project and BIDS settings
        
    Raises:
        ValueError: If unsupported file format is provided
    """
    if isinstance(config, str):
        if config.endswith('.json'):
            with open(config, 'r') as f:
                config_dict = json.load(f)
        elif config.endswith('.yml') or config.endswith('.yaml'):
            with open(config, 'r') as f:
                config_dict = yaml.safe_load(f)
        else:
            raise ValueError("Unsupported configuration file format. Use .json or .yml/.yaml")
    elif isinstance(config, dict):
        config_dict = deepcopy(config)
    
    bids_dict = deepcopy(config_dict['Project']) | deepcopy(config_dict['BIDS'])
    return bids_dict

def update_sidecars(config: dict):
    """
    Update BIDS sidecar JSON files with institutional and acquisition metadata.
    
    Finds all MEG files in BIDS structure and updates their JSON sidecars with:
    - Institution information (name, department, address)
    - Associated empty room recordings
    - Head position and movement data
    - MaxFilter processing parameters
    - Dewar position and HPI coil frequencies
    
    Args:
        config (dict): Configuration dictionary with BIDS root path and 
                      institution details
    
    Returns:
        None
        
    Side Effects:
        - Modifies existing JSON sidecar files
        - Adds metadata fields to comply with BIDS specification
    """
    bids_root = config['BIDS']
    proc_root = join(bids_root, DERIVATIVES_SUBFOLDER)
    # Find all meg files in the BIDS folder, ignore EEG for now
    bids_paths = find_matching_paths(bids_root,
                                     suffixes='meg',
                                    acquisitions=['triux', 'hedscan'],
                                    splits=None,
                                    descriptions=None,
                                     extensions='.fif',
                                     ignore_nosub=True)
    proc_bids_paths = find_matching_paths(proc_root,
                                     suffixes='meg',
                                    acquisitions=['triux', 'hedscan'],
                                    splits=None,
                                    descriptions=None,
                                     extensions='.fif')
    # Add institution name, department and address
    institution = {
            'InstitutionName': config['InstitutionName'],
            'InstitutionDepartmentName': config['InstitutionDepartmentName'],
            'InstitutionAddress': config['InstitutionName']
            }
    
    for bp in bids_paths + proc_bids_paths:
        if not file_contains(bp.basename, HEADPOS_PATTERNS + ['trans']):
            acq = bp.acquisition
            suffix = bp.suffix
            proc = bp.processing
            try:
                info = mne.io.read_info(bp.fpath, verbose='error')
            except Exception as e:
                print(bp.fpath, e)
                continue
            bp_json = bp.copy().update(extension='.json', split=None)
            # Check if json exists, if not create it
            if not exists(bp_json.fpath):
                try:
                    raw = read_raw_bids(bp, verbose='error')
                    _sidecar_json(raw=raw,
                                task=bp.task,
                                manufacturer='Elekta',
                                fname=bp_json.fpath,
                                datatype=bp.datatype)
                except Exception as e:
                    print(f"Warning: Could not create sidecar for {bp.basename}: {e}")
                    continue
            
            with open(str(bp_json.fpath), 'r') as f:
                sidecar = json.load(f)
            
            if not file_contains(bp.task.lower(), NOISE_PATTERNS):
                match_paths = find_matching_paths(
                                bp.directory,
                                acquisitions=acq,
                                suffixes='meg',
                                extensions='.fif')

                noise_paths = [p for p in match_paths if 'noise' in p.task.lower()]
                sidecar['AssociatedEmptyRoom'] = [basename(er) for er in noise_paths]
                
                # Find associated headpos and trans files
                headpos_file = find_matching_paths(
                    bp.directory,
                    bp.task,
                    acquisitions=acq,
                    descriptions='headpos',
                    extensions='.pos',
                )
                
                trans_file = find_matching_paths(
                    bp.directory,
                    bp.task,
                    acquisitions=acq,
                    descriptions='trans',
                    extensions='.fif',
                )
                if headpos_file:
                    path = f"{headpos_file[0].root}/{headpos_file[0].basename}"
                    headpos = mne.chpi.read_head_pos(path)
                    trans_head, rot, t = mne.chpi.head_pos_to_trans_rot_t(headpos)
                    sidecar['MaxMovement'] = round(float(trans_head.max()), 4)
                    
                if trans_file:
                    path = f"{headpos_file[0].root}/{headpos_file[0].basename}"
                    trans = mne.read_trans(path, verbose='error')

            if acq == 'triux' and suffix == 'meg':
                if info['gantry_angle'] > 0:
                    dewar_pos = f'upright ({int(info["gantry_angle"])} degrees)'
                else:
                    dewar_pos = f'supine ({int(info["gantry_angle"])} degrees)'
                sidecar['DewarPosition'] = dewar_pos
                try:
                    # mne.chpi.get_chpi_info(info)
                    sidecar['HeadCoilFrequency'] = [f['coil_freq'] for f in info['hpi_meas'][0]['hpi_coils']]
                except IndexError:
                    'No head coil frequency found'

                # sidecar['ContinuousHeadLocalization']
                
            # TODO: Add maxfilter and headposition parameters
            if proc:
                #print('Processing detected')
                proc_list = proc.split('+')
                if info['proc_history']:
                    max_info = info['proc_history'][0]['max_info']
                
                    if file_contains(proc, ['sss', 'tsss']):
                        sss_info = max_info['sss_info']
                        sidecar['SoftwareFilters']['MaxFilterVersion'] = info['proc_history'][0]['creator']

                        sidecar['SoftwareFilters']['SignalSpaceSeparation'] = {
                            'Origin': sss_info['origin'].tolist(),
                            'NComponents': sss_info['nfree'],
                            
                        }

                        if any(['hpi' in key for key in sss_info.keys()]):
                            sidecar['SoftwareFilters']['SignalSpaceSeparation'][ 'HpiGoodLimit'] = sss_info['hpi_g_limit']
                            sidecar['SoftwareFilters']['SignalSpaceSeparation']['HPIDistanceLimit'] = sss_info['hpi_dist_limit']

                        if ['tsss'] in proc_list:
                            max_st = max_info['max_st']
                            sidecar['SoftwareFilters']['TemporalSignalSpaceSeparation'] = {
                                'SubSpaceCorrelationLimit': max_st['subspcorr'],
                                'LengtOfDataBuffert': max_st['buflen']
                            }
            # sidecar['MaxMovement'] 
            # Add average head position file

            if acq == 'hedscan':
                sidecar['Manufacturer'] = 'FieldLine'
            
            new_sidecar = institution | sidecar
            
            if not new_sidecar == sidecar:

                with open(str(bp_json.fpath), 'w') as f:
                    json.dump(new_sidecar, f, indent=4)

def add_channel_parameters(
    bids_tsv: str,
    opm_tsv: str):

    print(bids_tsv, opm_tsv)
    """
    Merge additional channel parameters from OPM source file into BIDS channels.tsv.
    
    Compares OPM-specific channel file with BIDS channels file and adds any
    missing columns or parameters to ensure complete channel documentation.
    
    Args:
        bids_tsv (str): Path to BIDS channels.tsv file
        omp_tsv (str): Path to source OPM channels.tsv with additional parameters
    
    Returns:
        None
        
    Side Effects:
        - Updates BIDS channels.tsv file with merged data
        - Prints confirmation message
    """
    if exists(opm_tsv):
        orig_df = pd.read_csv(opm_tsv, sep='\t')
        if not exists(bids_tsv):
            bids_df = orig_df.copy()
        else:
            bids_df = pd.read_csv(bids_tsv, sep='\t')

        # Compare file with file in BIDS folder

        add_cols = [c for c in orig_df.columns
                    if c not in bids_df.columns] + ['name']

        if not np.array_equal(
            orig_df, bids_df):
            
            bids_df = bids_df.merge(orig_df[add_cols], on='name', how='outer')

            bids_df.to_csv(bids_tsv, sep='\t', index=False)
    print(f'Adding channel parameters to {basename(bids_tsv)}')

def copy_eeg_to_meg(file_name: str, bids_path: BIDSPath):
    """
    Copy EEG data files to MEG datatype directory in BIDS structure.
    
    For files containing only EEG channels, copies the data and metadata
    to the MEG directory and includes associated CapTrak digitization files.
    
    Args:
        file_name (str): Path to source EEG file
        bids_path (BIDSPath): BIDS path object for target location
    
    Returns:
        None
        
    Side Effects:
        - Saves EEG data as MEG datatype
        - Copies JSON metadata files
        - Copies associated CapTrak digitization files
    """
    
    if not file_contains(file_name, HEADPOS_PATTERNS + ['trans']):
        bids_path.update(extension='.vhdr')
        raw = read_raw_bids(bids_path, verbose='error')
        raw = mne.io.read_raw_fif(file_name, allow_maxshield=True, verbose='error')
        ch_types = set(raw.info.get_channel_types())
        # Confirm that the file is EEG
        if not 'meg' in ch_types:
            bids_json = find_matching_paths(bids_path.root,
                                    tasks=bids_path.task,
                                    suffixes='eeg',
                                    extensions='.json')[0]
            
            bids_eeg = bids_json.copy().update(datatype='meg',
                                                extension='.fif')
            
            raw.save(bids_eeg.fpath, overwrite=True)

            json_from = bids_json.fpath
            json_to = bids_json.copy().update(datatype='meg').fpath
            
            copy2(json_from, json_to)
            
            # Copy CapTrak files
            CapTrak = find_matching_paths(bids_eeg.root, spaces='CapTrak')
            for old_cap in CapTrak:
                new_cap = old_cap.copy().update(datatype='meg')
                if not exists(new_cap):
                    copy2(old_cap, new_cap)

###############################################################################
# Functions: Conversion Table Management
###############################################################################


def bids_path_from_rawname(file_name, date_session, config, pmap=None):
    """
    Extract BIDS path from filename using config and optional participant mapping.
    
    Args:
        file_name: Path to the raw file
        date_session: Session identifier
        config: Configuration dictionary containing all paths and settings
        pmap: Optional participant mapping dataframe
    
    Returns:
        BIDSPath object or None if extraction fails
    """
    # Extract info from filename
    if not exists(file_name):
        print(f"Not exists: {file_name}")
        return None
    
    bids_root = config.get('BIDS', '')
    info_dict = extract_info_from_filename(file_name)
    
    # Validate required fields
    task = info_dict.get('task')
    subject = info_dict.get('participant')
    if not task or not subject:
        print(f"Missing required fields in {file_name}")
        return None
    
    acquisition = basename(dirname(file_name))
    
    # Check if preprocessed and add derivatives path if so
    proc = '+'.join(info_dict.get('processing', []))
    if proc:
        bids_root = join(bids_root, DERIVATIVES_SUBFOLDER)
    
    # Build processing info
    split = info_dict.get('split')
    run = info_dict.get('run', '')
    desc = info_dict.get('description')
    extension = info_dict.get('extension')
    suffix = info_dict.get('suffix')
    
    # Strip prefix and zero-pad subject and session
    subj_out = subject
    session_out = str(date_session).replace('ses-', '')
    session_out = session_out.lstrip('0').zfill(2) if len(session_out) > 1 else session_out.zfill(2)

    # EVALUATE IF NEEDED TO MAP PARTICIPANT/SESSION IDS
    if pmap is not None:
        old_subj_id = config.get('Original_subjID_name', '')
        new_subj_id = config.get('New_subjID_name', '')
        old_session = config.get('Original_session_name', '')
        new_session = config.get('New_session_name', '')
        
        check_subj = subject in pmap[old_subj_id].values
        check_date = date_session in pmap.loc[pmap[old_subj_id] == subject, old_session].values
        
        if not all([check_subj, check_date]):
            print('Not mapped participant/session')
            return None  # Skip unmapped participants/sessions
            
        subj_out = str(pmap.loc[pmap[old_subj_id] == subject, new_subj_id].values[0]).zfill(3)
        session_out = str(pmap.loc[pmap[old_session] == date_session, new_session].values[0]).zfill(2)

    # Determine datatype by reading file (only if not headpos/trans)
    datatype = 'meg' # Default
    if not file_contains(basename(file_name), HEADPOS_PATTERNS + ['trans']):
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
            ch_types = ['']

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

def generate_new_conversion_table(config: dict, existing_table: pd.DataFrame = None):
    
    """
    For each participant and session within MEG folder, generate conversion table entries.
    Uses parallel processing for efficiency.
    """
    ts = datetime.now().strftime('%Y%m%d')
    path_project = join(config.get('Root', ''), config.get('Name', ''))
    path_raw = config.get('Raw', '')
    path_BIDS = config.get('BIDS', '')
    participant_mapping = join(path_project, config.get('Participants_mapping_file', ''))
    old_subj_id = config.get('Original_subjID_name', '')
    new_subj_id = config.get('New_subjID_name', '')
    old_session = config.get('Original_session_name', '')
    new_session = config.get('New_session_name', '')
    tasks = config.get('Tasks', []) + OPM_EXEPCIONS_PATTERNS
    
    processing_modalities = ['triux', 'hedscan']
    
    # Files already processed or skipped
    processed_files = set()
    if isinstance(existing_table, pd.DataFrame) and not existing_table.empty:
        processed_files = set(
            existing_table.loc[(existing_table['status'] == 'processed') |
                                (existing_table['status'] == 'skip')]
            .apply(lambda row: f"{row['raw_path']}/{row['raw_name']}", axis=1)
        )
    # Load participant mapping if available
    pmap = None
    if participant_mapping:
        try:
            pmap = pd.read_csv(participant_mapping, dtype=str)
        except Exception as e:
            print('Participant mapping file not found, skipping')
    
    participants = glob('sub-*', root_dir=path_raw)
    
    def process_file_entry(job):
        """Process a single file entry - designed for parallel execution"""
        participant, date_session, acquisition, file = job
        full_file_name = os.path.join(path_raw, participant, date_session, acquisition, file)
        
        # Check if BIDS conversion declared as processed or skipped in existing table
        if full_file_name in processed_files:
            # Second surface level check if participant exist
            if participant in glob('sub-*', root_dir=path_BIDS):
                return None  # Skip already processed files
        
        bids_path, info_dict = bids_path_from_rawname(full_file_name, date_session, config, pmap)
        
        if info_dict['split']:
            return None
        split = None
        splits = get_split_file_parts(full_file_name)
        if isinstance(splits, list):
            split = str(len(splits) - 1)
        
        if not bids_path:
            return None
        
        # Extract values from bids_path object
        task = bids_path.task
        run = bids_path.run
        datatype = bids_path.datatype
        proc = bids_path.processing
        desc = bids_path.description
        suffix = bids_path.suffix
        extension = bids_path.extension
        subj_out = bids_path.subject
        session_out = bids_path.session
        acquisition = bids_path.acquisition
        
        # Check for event file
        event_file = None
        if task:
            event_files = glob(f'{task}_event_id.json', root_dir=f'{path_BIDS}/..')
            if event_files:
                event_file = event_files[0]

        status = 'run'

        if task not in tasks + ['Noise']:
            status = 'check'

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
            'event_id': event_file
        }
    
    # Collect all jobs
    jobs = []
    for participant in participants:
        sessions = sorted([session for session in glob('*', root_dir=os.path.join(path_raw, participant)) 
                          if os.path.isdir(os.path.join(path_raw, participant, session))])
        for date_session in sessions:
            for acquisition in processing_modalities:
                all_files = sorted(glob('*.fif', root_dir=os.path.join(path_raw, participant, date_session, acquisition)) +
                                   glob('*.pos', root_dir=os.path.join(path_raw, participant, date_session, acquisition)))
                for file in all_files:
                    jobs.append((participant, date_session, acquisition, file))
    
    # Process jobs in parallel and collect results
    max_workers = min(4, os.cpu_count() or 1)  # Use up to 4 workers
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
    
    # Sort results by participant, session, acquisition, task, and raw_name for consistent ordering
    results.sort(key=lambda x: (x['participant_from'], x['session_from'], x['acquisition'], x['task'] or '', x['raw_name']))
    
    # Yield sorted results
    for result in results:
        yield result

def load_conversion_table(config: dict):
    """
    Load or generate conversion table for BIDS conversion process.
    
    Loads the most recent conversion table from logs directory, or generates
    a new one if none exists or if overwrite is requested.
    
    Args:
        config (dict): Configuration dictionary with BIDS path
        conversion_file (str, optional): Specific conversion file to load
        overwrite (bool): Force regeneration of conversion table
    
    Returns:
        pd.DataFrame: Conversion table with file mappings and metadata
        
    Side Effects:
        - Creates conversion_logs directory if missing
        - May generate new conversion table
        - Prints table loading information
    """
    # Load the most recent conversion table from config
    overwrite = config.get('Overwrite_conversion', False)
    logPath = setLogPath(config)
    conversion_file = config.get('Conversion_file', 'bids_conversion.tsv')
    if conversion_file == '':
        conversion_file = 'bids_conversion.tsv'

    if not os.path.exists(logPath):
        os.makedirs(logPath, exist_ok=True)
        print(f"Created new log path: {logPath}")
    
    # Check if conversion_file is a full path or just a filename
    if not os.path.isabs(conversion_file):
        conversion_file = os.path.join(logPath, conversion_file)
    
    if not os.path.exists(dirname(conversion_file)):
        os.makedirs(dirname(conversion_file), exist_ok=True)
        print("No conversion logs directory found. Created new")
    
    if conversion_file and exists(conversion_file) and os.path.isfile(conversion_file) and not overwrite:
        # Check if file is not empty before reading
        try:
            if os.path.getsize(conversion_file) > 0:
                print(f"Loading conversion table from {conversion_file}")
                conversion_table = pd.read_csv(conversion_file, sep='\t', dtype=str)
                return conversion_table, conversion_file
            else:
                print(f"Conversion file {conversion_file} is empty, generating new")
        except (pd.errors.EmptyDataError, ValueError) as e:
            print(f"Conversion file {conversion_file} is corrupted or empty, generating new")
    else:
        if overwrite:
            print(f'Overwrite requested, generating new conversion table')
        elif not conversion_file:
            print(f'No conversion file specified, generating new')
        else:
            print(f'Conversion file {conversion_file} not found, generating new')
        
        results = list(generate_new_conversion_table(config))
        conversion_table = pd.DataFrame(results)

        conversion_table.to_csv(conversion_file, sep='\t', index=False)
        print(f"New conversion table generated and saved to {basename(conversion_file)}")
        while not exists(conversion_file):
            time.sleep(0.5)
        # After generation, load the newly created file
        conversion_files = sorted(
            glob(os.path.join(logPath, '*.tsv')),
            key=os.path.getctime
        )
        print(f"Found conversion files: {conversion_files}")
        if conversion_files:
            latest_conversion_file = conversion_files[-1]
            print(f"Loading the most recent conversion table: {basename(latest_conversion_file)}")
            try:
                if os.path.getsize(latest_conversion_file) > 0:
                    conversion_table = pd.read_csv(latest_conversion_file, sep='\t', dtype=str)
                    return conversion_table, latest_conversion_file
                else:
                    print(f"Warning: Generated conversion table is empty. No files found to convert.")
                    # Return empty DataFrame with expected columns
                    return pd.DataFrame(columns=['time_stamp', 'status', 'participant_from', 'participant_to', 
                                                'session_from', 'session_to', 'task', 'split', 'run', 'datatype',
                                                'acquisition', 'processing', 'description', 'raw_path', 'raw_name',
                                                'bids_path', 'bids_name', 'event_id']), latest_conversion_file
            except (pd.errors.EmptyDataError, ValueError) as e:
                print(f"Warning: Generated conversion table is corrupted or empty: {e}")
                return pd.DataFrame(columns=['time_stamp', 'status', 'participant_from', 'participant_to', 
                                            'session_from', 'session_to', 'task', 'split', 'run', 'datatype',
                                            'acquisition', 'processing', 'description', 'raw_path', 'raw_name',
                                            'bids_path', 'bids_name', 'event_id']), latest_conversion_file
        else:
            raise FileNotFoundError("No conversion files found after generation")

def update_conversion_table(config, conversion_file=None):
    """
    Update conversion table to add new files not currently tracked.
    
    Args:
        config (dict): Configuration dictionary with BIDS path and settings
    
    Returns:
        pd.DataFrame: Updated conversion table with new files added
        
    Side Effects:
        - Adds new entries for discovered files
        - Set status of new files to 'run' or 'check'
    """
    existing_conversion_table, existing_conversion_file = load_conversion_table(config)
    if not conversion_file:
        conversion_file = existing_conversion_file
    
    results = list(generate_new_conversion_table(config, existing_conversion_table))
    new_conversion_table = pd.DataFrame(results)
    
    run_conversion = True
    # If no new results, return existing table
    if new_conversion_table.empty:
        run_conversion = False
        print("No files found to add to conversion table.")
        return existing_conversion_table, conversion_file, run_conversion
    
    # ignore split files
    # if 'split' in new_conversion_table.columns:
    #     new_conversion_table = new_conversion_table[new_conversion_table['split'].isna() | 
    #                                                 (new_conversion_table['split'] == '')]
    
    # Double check if bids_file exists (only if existing table has data)
    if not existing_conversion_table.empty and 'bids_name' in existing_conversion_table.columns:
        for i, row in existing_conversion_table.iterrows():
            if pd.notna(row.get('bids_name')) and pd.notna(row.get('bids_path')):
                bids_files = glob('*'.join(row['bids_name'].split('_')), root_dir=row['bids_path'])
                if not bids_files and not row['status'] == 'check':
                    existing_conversion_table.loc[i, 'status'] = 'run'
                for bids_file in bids_files:
                    bids_path = get_bids_path_from_fname(os.path.join(row['bids_path'], bids_file))
                    if (find_matching_paths(
                        bids_path.directory,
                        tasks=bids_path.task,
                        acquisitions=bids_path.acquisition,
                        suffixes=None if bids_path.suffix is None else bids_path.suffix,
                        descriptions=None if bids_path.description is None else bids_path.description,
                        extensions=None if bids_path.extension is None else bids_path.extension
                    )):
                        existing_conversion_table.loc[i, 'status'] = 'processed'
                        break
    
    # Extract files not in existing conversion table
    # Merge new_conversion_table into existing_conversion_table based on 'raw_path' and 'raw_name'
    # For other columns, keep values from existing_conversion_table if present
    if existing_conversion_table.empty:
        # If existing table is empty, all new entries are the diff
        diff = new_conversion_table
    else:
        # Find new rows not present in existing table (by raw_path and raw_name)
        merged = new_conversion_table.merge(
            existing_conversion_table[['raw_path', 'raw_name']],
            on=['raw_path', 'raw_name'],
            how='left',
            indicator=True
        )
        diff = merged[merged['_merge'] == 'left_only']
        diff = diff.drop(columns=['_merge']).reset_index(drop=True)
    if diff.empty:
        run_conversion = False
        print("No new files to add to conversion table.")
        return existing_conversion_table, conversion_file, run_conversion
    
    else:
        # Set status to 'run' only for processed/skip files, preserve 'check' status
        if 'status' in diff.columns:
            # Only change 'processed' and 'skip' to 'run', keep 'check' as is
            diff.loc[diff['status'].isin(['processed', 'skip']), 'status'] = 'run'
            # Note: 'check' status is preserved for tasks not in approved list
        
        updated_table = pd.concat([existing_conversion_table, diff], ignore_index=True)
        
        print(f"Adding {len(diff)} new files to conversion table.")
        
        return updated_table, conversion_file, run_conversion

def bidsify(config: dict):
    """
    Main function to convert raw MEG/EEG data to BIDS format.
    
    Comprehensive conversion process that:
    1. Loads/updates conversion table
    2. Creates BIDS directory structure
    3. Processes each file according to conversion table
    4. Handles MEG, EEG, head position, and transformation files
    5. Associates event files with task data
    6. Manages calibration and crosstalk files
    7. Logs all conversion activities
    
    Conversion Features:
    - Supports both TRIUX (SQUID) and OPM MEG systems
    - Handles split files automatically
    - Zero-pads subject and session IDs
    - Associates event files with tasks
    - Copies head position and transformation files
    - Manages channel parameter files for OPM data
    - Robust error handling with fallback options
    
    Args:
        config (dict): Complete configuration with paths and parameters
        conversion_file (str, optional): Specific conversion table to use
        overwrite (bool): Whether to overwrite existing BIDS files
    
    Returns:
        None
        
    Side Effects:
        - Creates complete BIDS directory structure
        - Converts all eligible raw files to BIDS format
        - Writes calibration and crosstalk files
        - Updates conversion table with completion status
        - Logs all conversion activities
        
    Raises:
        SystemExit: If task validation fails (unknown tasks found)
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

    df, conversion_file, run_conversion = update_conversion_table(config)
    
    if not run_conversion or overwrite:
        print("No new files to convert. Exiting bidsify process.")
        return
    
    if df.empty or not conversion_file:
        print("Conversion table empty or not defined")
        return

    df = df.where(pd.notnull(df) & (df != ''), None)
    
    pmap = None
    if participant_mapping:
        try:
            pmap = pd.read_csv(participant_mapping, dtype=str)
        except Exception as e:
            print('Participant file not found, skipping')
    
    # Start by creating the BIDS directory structure
    unique_participants_sessions = df[['participant_to', 'session_to', 'datatype']].drop_duplicates()
    for _, row in unique_participants_sessions.iterrows():
        
        if len(str(row['participant_to']).lstrip('0')) < 3:
            subject_padded = str(row['participant_to']).lstrip('0').zfill(3)
        else:
            subject_padded = str(row['participant_to']).zfill(4)
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
    
    # ignore split files as they are processed automatically
    # if 'split' in df.columns:
    #     df = df[df['split'].isna() | (df['split'] == '')]

    # Flag deviants and exist if found
    deviants = df[df['status'] == 'check']
    if len(deviants) > 0:
        print('Deviant tasks found, please check the conversion table and run again')
        df.to_csv(conversion_file, sep='\t', index=False)
        # update_bids_report(df, config)
        return

    n_files_to_process = len(df[df['status'] == 'run'])
    
    # Create progress bar for files to process

    pbar = tqdm(total=n_files_to_process, 
                desc=f"Bidsify files", 
                unit=" file(s)",
                disable=not sys.stdout.isatty(),
                ncols=80,
                bar_format='{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}]')
    pcount = 0
    for i, d in df.iterrows():
        try:
            # Skip files not ready for conversion
            if d['status'] in ['processed', 'skip'] and not overwrite:
                #print(f"{d['bids_name']} already converted")
                continue
            pcount += 1
            # if d[d['status'] == 'run']:
            print(f"Processing file {pcount}/{n_files_to_process}: {d['raw_name']}")
            # Update progress bar for each file being processed
            pbar.update(1)
            
            bids_path = None

            raw_file = f"{d['raw_path']}/{d['raw_name']}"

            bids_path, raw_info = bids_path_from_rawname(raw_file,
                                                d['session_from'],
                                                config,
                                                pmap)

            event_id = d['event_id']
            events = None
            run = None
            if pd.notna(d['run']) and d['run'] != '':
                run = str(d['run']).zfill(2)

            if pd.notna(event_id) and event_id:
                with open(f"{path_BIDS}/../{event_id}", 'r') as f:
                    event_id = json.load(f)
                events = mne.find_events(raw)

            # Create BIDS path
            bids_path.update(
                subject=subject_padded,
                session=str(d['session_to']).zfill(2),
                task=d['task'],
                acquisition=None if pd.isna(d['acquisition']) or d['acquisition'] == '' else d['acquisition'],
                processing=None if pd.isna(d['processing']) or d['processing'] == '' else d['processing'],
                description=None if pd.isna(d['description']) or d['description'] == '' else d['description'],
                run=run
            )
            
            if bids_path.description and 'trans' in bids_path.description:
                trans = mne.read_trans(raw_file, verbose='error')
                mne.write_trans(bids_path, trans, overwrite=True)
                    
            elif bids_path.suffix and 'headshape' in bids_path.suffix:
                headpos = mne.chpi.read_head_pos(raw_file)
                mne.chpi.write_head_pos(bids_path, headpos)

            elif bids_path.datatype in ['meg', 'eeg']:
            # Write the BIDS file
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
                    
                    # Ensure JSON sidecar exists for processed files
                    if bids_path.processing:
                        json_path = bids_path.copy().update(extension='.json', split=None)
                        if not exists(json_path.fpath):
                            print(f"Creating missing JSON sidecar: {json_path.basename}")
                            # Create minimal sidecar
                            sidecar_data = {
                                'TaskName': bids_path.task,
                                'SamplingFrequency': raw.info['sfreq'],
                                'PowerLineFrequency': raw.info['line_freq'],
                                'Manufacturer': 'Elekta'
                            }
                            with open(json_path.fpath, 'w') as f:
                                json.dump(sidecar_data, f, indent=4)
                    
                    # Operation tracked via JSON logging in update_bids_report()
                            
                except Exception as e:
                    print(f"Error writing BIDS file: {e}")
                    # If write_raw_bids fails, try to save the raw file directly
                    # Fall back on raw.save if write_raw_bids fails
                    fname = bids_path.copy().update(suffix='meg', extension = '.fif').fpath
                    try:
                        raw.save(fname, overwrite=True, verbose='error')
                    except Exception as e:
                        
                        print(f"Error saving raw file: {e}")

                # Copy EEG to MEG
                if bids_path.datatype == 'eeg':
                    copy_eeg_to_meg(raw_file, bids_path)

            # Add channel parameters 
            elif bids_path.acquisition == 'hedscan' and not bids_path.processing:
                
                opm_tsv = f"{d['raw_path']}/{d['raw_name']}".replace('raw.fif', 'channels.tsv')
                
                bids_tsv = bids_path.copy().update(suffix='channels', extension='.tsv')
                add_channel_parameters(bids_tsv, opm_tsv)
        
            # Update the conversion table if successful    
            df.at[i, 'status'] = 'processed'
            
        except Exception as e:
            print(f"Error processing file {d['raw_name']}: {e}")
            df.at[i, 'status'] = 'error'
        
        df.at[i, 'time_stamp'] = ts
        df.at[i, 'bids_path'] = dirname(bids_path)
        df.at[i, 'bids_name'] = basename(bids_path)
        df.to_csv(conversion_file, sep='\t', index=False)

    # Close progress bar
    pbar.close()
    
    # Update BIDS processing report in JSON format for pipeline tracking
    update_bids_report(df, config)
    print(f"All files bidsified according to {conversion_file}")

def update_bids_report(conversion_table: pd.DataFrame, config: dict):

    """
    Update the BIDS results report with processed entries in JSON format, 
    linking to the copy results for complete pipeline tracking.
    
    Creates a JSON report similar to copy_results.json but for BIDS conversions,
    allowing tracking of the complete pipeline from copy → BIDS.
    
    Args:
        conversion_table (pd.DataFrame): Conversion table with BIDS processing results
        config (dict): Configuration dictionary containing project paths
    
    Returns:
        int: Number of entries processed
    """
    bids_root = config.get('BIDS', '')
    logPath = setLogPath(config)
    report_file = os.path.join(logPath, 'bids_results.json')
    
    # Load existing report if it exists
    existing_report = []
    if exists(report_file):
        try:
            with open(report_file, 'r') as f:
                existing_report = json.load(f)
                # If someone already saved a combined dict, pull out the 'Report Table'
                if isinstance(existing_report, dict) and 'Report Table' in existing_report:
                    existing_report = existing_report.get('Report Table', [])
        except (json.JSONDecodeError, FileNotFoundError):
            existing_report = []
    
    def create_entry(source_file, destination_file, row):
        entry = {}
        bids_file = os.path.join(row['bids_path'].replace(config.get('BIDS', ''), ''), os.path.basename(destination_file))
        entry['Source File'] = source_file
        
        # Only add source size if file exists
        try:
            entry['Source Size'] = getsize(source_file) if exists(source_file) else 0
        except (OSError, FileNotFoundError):
            entry['Source Size'] = 0
            
        entry['BIDS File'] = destination_file
        
        # Only add BIDS size and modification date if file exists
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
        entry['Participant'] = row['participant_to'] if pd.notna(row['participant_to']) else 'N/A'
        entry['Session'] = row['session_to'] if pd.notna(row['session_to']) else 'N/A'
        entry['Task'] = row['task'] if pd.notna(row['task']) else 'N/A'
        entry['Acquisition'] = row['acquisition'] if pd.notna(row['acquisition']) and row['acquisition'] else 'N/A'
        entry['Datatype'] = row['datatype'] if pd.notna(row['datatype']) else 'N/A'
        entry['Processing'] = row['processing'] if pd.notna(row['processing']) and row['processing'] else 'N/A'
        entry['Splits'] = row['split'] if pd.notna(row['split']) and row['split'] else 'N/A'
        entry['Conversion Status'] = row['status'] if pd.notna(row['status']) else 'error'
        entry['timestamp'] = datetime.now().isoformat()

        return entry
        
    
    # Group split files together by base filename
    df = conversion_table.drop_duplicates(subset=['raw_path', 'raw_name', 'bids_path', 'bids_name'])
    # Normalize NaN / empty strings to None so JSON serialization does not break
    df = df.where(pd.notnull(df) & (df != ''), None)
    # Ensure object dtype so None values are preserved without casting issues
    for col in df.columns:
        if df[col].dtype != object:
            df[col] = df[col].astype(object)
    grouped_entries = []
    for i, row in df.iterrows():
        source_file = f"{row['raw_path']}/{row['raw_name']}"
        source_base = re.sub(r'_raw-\d+\.fif$', '.fif', source_file)
        
        # Construct the full BIDS file path as a string
        bids_file_path = join(row['bids_path'], row['bids_name'])
        
        # Create a base key for grouping (remove split suffixes)
        source_files = get_split_file_parts(source_base)
        destination_files = get_split_file_parts(bids_file_path)

        # Normalize both to lists for consistent handling
        if not isinstance(source_files, list):
            source_files = [source_files]
        if not isinstance(destination_files, list):
            destination_files = [destination_files]
            
        # If we have mismatched counts, use the shorter one to avoid zip truncation issues
        for source_file, destination_file in zip(source_files, destination_files):
            grouped_entries.append(create_entry(source_file, destination_file, row))                
                        
    
    def _same_without_timestamp(a, b):
        """Return True if dicts a and b are equal when ignoring 'timestamp'."""
        a_filtered = {k: v for k, v in a.items() if k != 'timestamp'}
        b_filtered = {k: v for k, v in b.items() if k != 'timestamp'}
        return a_filtered == b_filtered

    new_entries = []
    for entry in grouped_entries:
        if not any(_same_without_timestamp(entry, existing) for existing in existing_report):
            new_entries.append(entry)
    
    if not new_entries:
        print("[INFO] No new entries to add to BIDS results report.")
        return 0
    # Combine existing and new entries
    updated_report = existing_report + new_entries
    len(updated_report)
    
    final_report = {}
    participants_file = glob('participants.tsv', root_dir=bids_root)
    data_description_file = glob('dataset_description.json', root_dir=bids_root)
    # The pipeline is considered complete only if every row has Conversion Status 'processed'
    try:
        conversion_status = 'Complete' if all(
            str(entry.get('Conversion Status', '')).lower() == 'processed' for entry in updated_report
        ) else 'Incomplete'
    except Exception:
        conversion_status = 'Incomplete'
    
    final_report['BIDS Summary'] = {
        'Conversion Status': conversion_status,
        'Participants file': participants_file[0] if participants_file else 'Not found',
        'Data description': data_description_file[0] if data_description_file else 'Not found'
    }
    
    final_report['Report Table'] = updated_report
    
    # Write updated report back to file, ensuring valid JSON
    try:
        # Always write a dict with the report table under the 'Report Table' key
        with open(report_file, 'w') as f:
            json.dump(final_report, f, indent=4, allow_nan=False)
        print(f"[INFO] BIDS results report written to: {report_file}")
    except Exception as e:
        print(f"[ERROR] Failed to write BIDS results report to {report_file}: {e}")

    print(f"BIDS report updated: {len(new_entries)} new entries added to existing {len(existing_report)} entries")

    return len(new_entries)   

def args_parser():
    """
    Parse command-line arguments for bidsify script.
    
    Defines command-line interface for standalone script execution with
    options for configuration file, conversion table, and overwrite settings.
    
    Returns:
        argparse.Namespace: Parsed command-line arguments
    """
    parser = argparse.ArgumentParser(description=
    '''
    BIDS Conversion Pipeline

    Arguments:
        --config   Path to config file (YAML or JSON)
        --analyse  Only make or update the conversion table (no conversion)
        --run      Execute the BIDS conversion pipeline (convert files)
        --report   Generate BIDS report (JSON summary)

    Viewer Pages:
        Conversion Table:  [logs/bids_conversion.tsv]
        BIDS Report:       [logs/bids_results.json]
        Summary:           [logs/bids_results.json]
        Editor:            [logs/bids_conversion.tsv] (editable)
        Log:               [logs/bidsify.log]

    You can open these files from the Electron viewer's navigation menu.
    ''', add_help=True)
    parser.add_argument('--config', type=str, required=True, help='Path to config file (YAML or JSON)')
    parser.add_argument('--analyse', action='store_true', help='Make or update conversion table only')
    parser.add_argument('--run', action='store_true', help='Execute BIDS conversion pipeline')
    parser.add_argument('--report', action='store_true', help='Generate BIDS report (JSON summary)')
    args = parser.parse_args()
    return args

def main(config:str=None):
    """
    Main entry point for BIDS conversion pipeline.
    
    Orchestrates the complete BIDS conversion process:
    1. Loads configuration (from file or parameter)
    2. Creates dataset description
    3. Runs main bidsification process
    4. Updates JSON sidecars with metadata
    5. Displays final BIDS directory tree
    
    Args:
        config (dict, optional): Configuration dictionary. If None, loads from
                                command-line arguments or user selection.
    
    Returns:
        None
        
    Side Effects:
        - Executes complete BIDS conversion pipeline
        - Prints directory tree of final BIDS structure
        
    Raises:
        SystemExit: If no configuration file is provided
    """
    
    if config is None:
        # Parse command line arguments
        args = args_parser()
        
        if args.config:
            config_file = args.config
        else:
            print('Use --config to specify a configuration file')
            sys.exit(1)
        
        if config_file:
            config = get_parameters(config_file)
            
        
        else:
            print('No configuration file selected')
            sys.exit(1)
    
    if isinstance(config, str):
        # If config is a string, assume it's a path to a config file
        config = get_parameters(config)
    
    # Only generate conversion table, don't convert files
    if args.analyse:
        print("Generating conversion table only")
        conversion_table, conversion_file, run_conversion = update_conversion_table(config)
        conversion_table['status'] = conversion_table['status'].fillna('error')
        conversion_table.to_csv(conversion_file, sep='\t', index=False)
        print(f"Conversion table saved to: {conversion_file}")
    
    if args.run:
        # Full conversion mode
        print("Running full BIDS conversion")
        create_dataset_description(config)
        create_proc_description(config)
        bidsify(config)
        update_sidecars(config)
    if args.report:
        # Generate report only
        print("Generating BIDS conversion report")
        update_bids_report(load_conversion_table(config)[0], config)
    return True

if __name__ == "__main__":
    main()
