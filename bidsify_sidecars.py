import json
from os.path import basename, dirname, exists, join
from shutil import copy2

import numpy as np
import pandas as pd
import mne
from mne_bids import read_raw_bids, find_matching_paths
from mne_bids.write import _sidecar_json

from bidsify_constants import HEADPOS_PATTERNS, NOISE_PATTERNS, DERIVATIVES_SUBFOLDER
from bidsify_utils import file_contains

mne.set_log_level('WARNING')


def update_sidecars(config: dict):
    """
    Update BIDS sidecar JSON files with institutional and acquisition metadata.
    """
    bids_root = config['BIDS']
    proc_root = join(bids_root, DERIVATIVES_SUBFOLDER)

    bids_paths = find_matching_paths(
        bids_root,
        suffixes='meg',
        acquisitions=['triux', 'hedscan'],
        splits=None,
        descriptions=None,
        extensions='.fif',
        ignore_nosub=True
    )
    proc_bids_paths = find_matching_paths(
        proc_root,
        suffixes='meg',
        acquisitions=['triux', 'hedscan'],
        splits=None,
        descriptions=None,
        extensions='.fif'
    )

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
            if not exists(bp_json.fpath):
                try:
                    raw = read_raw_bids(bp, verbose='error')
                    _sidecar_json(
                        raw=raw,
                        task=bp.task,
                        manufacturer='Elekta',
                        fname=bp_json.fpath,
                        datatype=bp.datatype
                    )
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
                    extensions='.fif'
                )

                noise_paths = [p for p in match_paths if 'noise' in p.task.lower()]
                sidecar['AssociatedEmptyRoom'] = [basename(er) for er in noise_paths]

                headpos_file = find_matching_paths(
                    bp.directory,
                    bp.task,
                    acquisitions=acq,
                    descriptions='headpos',
                    extensions='.pos'
                )

                trans_file = find_matching_paths(
                    bp.directory,
                    bp.task,
                    acquisitions=acq,
                    descriptions='trans',
                    extensions='.fif'
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
                    dewar_pos = f"upright ({int(info['gantry_angle'])} degrees)"
                else:
                    dewar_pos = f"supine ({int(info['gantry_angle'])} degrees)"
                sidecar['DewarPosition'] = dewar_pos
                try:
                    sidecar['HeadCoilFrequency'] = [f['coil_freq'] for f in info['hpi_meas'][0]['hpi_coils']]
                except IndexError:
                    'No head coil frequency found'

            if proc:
                proc_list = proc.split('+')
                if info['proc_history']:
                    max_info = info['proc_history'][0]['max_info']

                    if file_contains(proc, ['sss', 'tsss']):
                        sss_info = max_info['sss_info']
                        sidecar['SoftwareFilters']['MaxFilterVersion'] = info['proc_history'][0]['creator']

                        sidecar['SoftwareFilters']['SignalSpaceSeparation'] = {
                            'Origin': sss_info['origin'].tolist(),
                            'NComponents': sss_info['nfree']
                        }

                        if any(['hpi' in key for key in sss_info.keys()]):
                            sidecar['SoftwareFilters']['SignalSpaceSeparation']['HpiGoodLimit'] = sss_info['hpi_g_limit']
                            sidecar['SoftwareFilters']['SignalSpaceSeparation']['HPIDistanceLimit'] = sss_info['hpi_dist_limit']

                        if ['tsss'] in proc_list:
                            max_st = max_info['max_st']
                            sidecar['SoftwareFilters']['TemporalSignalSpaceSeparation'] = {
                                'SubSpaceCorrelationLimit': max_st['subspcorr'],
                                'LengtOfDataBuffert': max_st['buflen']
                            }

            if acq == 'hedscan':
                sidecar['Manufacturer'] = 'FieldLine'

            new_sidecar = institution | sidecar

            if new_sidecar != sidecar:
                with open(str(bp_json.fpath), 'w') as f:
                    json.dump(new_sidecar, f, indent=4)


def add_channel_parameters(bids_tsv: str, opm_tsv: str):
    print(bids_tsv, opm_tsv)
    if exists(opm_tsv):
        orig_df = pd.read_csv(opm_tsv, sep='\t')
        if not exists(bids_tsv):
            bids_df = orig_df.copy()
        else:
            bids_df = pd.read_csv(bids_tsv, sep='\t')

        add_cols = [c for c in orig_df.columns if c not in bids_df.columns] + ['name']

        if not np.array_equal(orig_df, bids_df):
            bids_df = bids_df.merge(orig_df[add_cols], on='name', how='outer')
            bids_df.to_csv(bids_tsv, sep='\t', index=False)
    print(f'Adding channel parameters to {basename(bids_tsv)}')


def copy_eeg_to_meg(file_name: str, bids_path):
    if not file_contains(file_name, HEADPOS_PATTERNS + ['trans']):
        bids_path.update(extension='.vhdr')
        raw = read_raw_bids(bids_path, verbose='error')
        raw = mne.io.read_raw_fif(file_name, allow_maxshield=True, verbose='error')
        ch_types = set(raw.info.get_channel_types())
        if 'meg' not in ch_types:
            bids_json = find_matching_paths(
                bids_path.root,
                tasks=bids_path.task,
                suffixes='eeg',
                extensions='.json'
            )[0]

            bids_eeg = bids_json.copy().update(datatype='meg', extension='.fif')

            raw.save(bids_eeg.fpath, overwrite=True)

            json_from = bids_json.fpath
            json_to = bids_json.copy().update(datatype='meg').fpath

            copy2(json_from, json_to)

            CapTrak = find_matching_paths(bids_eeg.root, spaces='CapTrak')
            for old_cap in CapTrak:
                new_cap = old_cap.copy().update(datatype='meg')
                if not exists(new_cap):
                    copy2(old_cap, new_cap)
