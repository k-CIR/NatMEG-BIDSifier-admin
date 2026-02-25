import json
import os
from glob import glob
from os.path import exists, join

import pandas as pd
from mne_bids import make_dataset_description

from bidsify_constants import DERIVATIVES_SUBFOLDER


def create_dataset_description(config: dict):
    """
    Create or update BIDS dataset_description.json file with metadata.
    """
    dataset_desc = config.get('Dataset_description', {})
    bids_path = config.get('BIDS', {})
    os.makedirs(bids_path, exist_ok=True)

    file_bids = f"{bids_path}/{dataset_desc}"

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

        generated_by = config.get('GeneratedBy', None)
        if generated_by:
            with open(file_bids, 'r') as f:
                desc_data = json.load(f)
            desc_data['GeneratedBy'] = generated_by
            with open(file_bids, 'w') as f:
                json.dump(desc_data, f, indent=4)


def create_participants_files(config: dict):
    """
    Create BIDS participants.tsv and participants.json files with default structure.
    """
    os.makedirs(config['BIDS'], exist_ok=True)

    participants_filename = config.get('Participants', 'participants.tsv')
    tsv_file = os.path.join(config['BIDS'], participants_filename)
    if not exists(tsv_file) or config.get('overwrite', False):
        participants = glob('sub*', root_dir=config['BIDS'])
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
                "Description": "Group of participant. By default everyone is in control group"
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
        'corr': 'Correlation threshold applied',
        'tsss': 'Temporal Signal Space Separation (tSSS) applied'
    }
    df = pd.DataFrame(list(proc_mapping.items()), columns=['desc_id', 'description'])
    df.to_csv(join(proc_root, 'descriptions.tsv'), sep='\t', index=False)
