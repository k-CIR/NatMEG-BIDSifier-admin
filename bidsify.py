"""Thin wrapper for the split bidsify modules."""

from bidsify_constants import (
    EXCLUDE_PATTERNS,
    NOISE_PATTERNS,
    HEADPOS_PATTERNS,
    OPM_EXEPCIONS_PATTERNS,
    PROC_PATTERNS,
    CONVERSION_TABLE_FIELDS,
    DERIVATIVES_SUBFOLDER,
)
from bidsify_utils import setLogPath, file_contains, get_parameters
from bidsify_parsing import extract_info_from_filename, get_split_file_parts, bids_path_from_rawname
from bidsify_templates import create_dataset_description, create_participants_files, create_proc_description
from bidsify_sidecars import update_sidecars, add_channel_parameters, copy_eeg_to_meg
from bidsify_conversion_table import generate_new_conversion_table, load_conversion_table, update_conversion_table
from bidsify_pipeline import bidsify, update_bids_report, args_parser, main

__all__ = [
    'EXCLUDE_PATTERNS',
    'NOISE_PATTERNS',
    'HEADPOS_PATTERNS',
    'OPM_EXEPCIONS_PATTERNS',
    'PROC_PATTERNS',
    'CONVERSION_TABLE_FIELDS',
    'DERIVATIVES_SUBFOLDER',
    'setLogPath',
    'file_contains',
    'get_parameters',
    'extract_info_from_filename',
    'get_split_file_parts',
    'bids_path_from_rawname',
    'create_dataset_description',
    'create_participants_files',
    'create_proc_description',
    'update_sidecars',
    'add_channel_parameters',
    'copy_eeg_to_meg',
    'generate_new_conversion_table',
    'load_conversion_table',
    'update_conversion_table',
    'bidsify',
    'update_bids_report',
    'args_parser',
    'main',
]

if __name__ == '__main__':
    main()
