import json
import os
import yaml
from copy import deepcopy
from os.path import exists, basename, dirname, join


def setLogPath(config: dict = None, LogPath: str = None):
    """
    Check config and set preferred logging location.
    LogPath overrides config setting if provided.
    """
    if LogPath:
        log_path = LogPath
        os.makedirs(log_path, exist_ok=True)
        return log_path

    project_name = config.get('Name', {}) or config.get('name', {}) or ''
    root = config.get('Root', {}) or config.get('root', '')

    # Check project root and name to not duplicate project name
    project_root = join(root, project_name) if project_name != basename(root) else root
    log_path = join(project_root, 'logs')

    # If not log_path exists try via BIDS path
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
    """
    import re
    return bool(re.compile('|'.join(pattern)).search(file))


def get_parameters(config):
    """
    Extract and merge BIDS configuration parameters from file or dictionary.
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
    else:
        raise ValueError("Unsupported configuration type. Use dict or file path")

    bids_dict = deepcopy(config_dict['Project']) | deepcopy(config_dict['BIDS'])
    return bids_dict
