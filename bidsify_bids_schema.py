"""
BIDS Schema validator — validates completed BIDS conversions and checks metadata compliance.
Supports MEG, EEG, and hybrid modalities with intelligent schema validation.
Focuses on post-conversion validation (not pre-conversion checks on raw data).
"""

import json
import mne
from os.path import exists, join
from typing import Dict, List, Any, Optional, Tuple
from pathlib import Path
import pandas as pd
import os


# BIDS required fields by modality (core fields that must be present)
BIDS_REQUIRED_FIELDS = {
    'meg': {
        'dataset_description': ['Name', 'BIDSVersion', 'DatasetType'],
        'meg_json': ['TaskName', 'SamplingFrequency', 'PowerLineFrequency'],
        'channels': ['name', 'x', 'y', 'z', 'type'],
    },
    'eeg': {
        'dataset_description': ['Name', 'BIDSVersion', 'DatasetType'],
        'eeg_json': ['TaskName', 'SamplingFrequency', 'PowerLineFrequency', 'EEGReference'],
        'channels': ['name', 'x', 'y', 'z', 'type'],
    },
    'ieeg': {
        'dataset_description': ['Name', 'BIDSVersion', 'DatasetType'],
        'ieeg_json': ['TaskName', 'SamplingFrequency'],
        'channels': ['name', 'x', 'y', 'z', 'type'],
    },
}

# Optional but recommended fields
BIDS_RECOMMENDED_FIELDS = {
    'meg': ['RepetitionTime', 'EchoTime', 'HeadLocationBIDSCoordinates', 'DewarPosition', 'Manufacturer'],
    'eeg': ['RepetitionTime', 'EchoTime', 'Montage', 'Manufacturer'],
}

# Field constraints (min/max values, allowed values, etc.)
BIDS_CONSTRAINTS = {
    'SamplingFrequency': {'type': 'number', 'min': 10, 'max': 500000},
    'PowerLineFrequency': {'type': 'number', 'values': [50, 60]},
    'NumberOfChannels': {'type': 'integer', 'min': 1},
    'SoftwareFilters': {'type': 'object', 'required_keys': ['FrequencyHighPass', 'FrequencyLowPass']},
}


class BIDSSchemaValidator:
    """
    Validates BIDS metadata compliance and identifies data quality issues.
    """

    def __init__(self, bids_root: str, config: dict):
        """
        Initialize validator with BIDS root path and config.
        
        Args:
            bids_root: Path to BIDS dataset root
            config: Configuration dict with modality info  
        """
        self.bids_root = bids_root
        self.config = config
        self.issues = []
        self.modality = config.get('Modality', 'meg').lower()
        self.bids_validator_output = None
        self._load_bids_validator_results()

    def validate_dataset_structure(self) -> List[Dict[str, Any]]:
        """
        Validate dataset-level structure (dataset_description.json, README, etc.).
        """
        issues = []
        
        # Check dataset_description.json
        desc_file = join(self.bids_root, 'dataset_description.json')
        if not exists(desc_file):
            issue = {
                'file': 'dataset_description.json',
                'category': 'BIDS',
                'severity': 'error',
                'issue': 'Missing dataset_description.json at BIDS root',
                'suggestion': 'Create dataset_description.json with required fields: Name, BIDSVersion, DatasetType',
                'affected_fields': ['dataset_description.json'],
                'bids_level': 'dataset'
            }
            validator_info = self._link_to_bids_validator('dataset_description.json', issue['issue'])
            if validator_info:
                issue['validator_reference'] = validator_info
            issues.append(issue)
        else:
            try:
                with open(desc_file, 'r') as f:
                    content = f.read()
                    desc = json.loads(content)
                
                required = BIDS_REQUIRED_FIELDS['meg']['dataset_description']
                for field in required:
                    if field not in desc:
                        issue = {
                            'file': 'dataset_description.json',
                            'category': 'BIDS',
                            'severity': 'error',
                            'issue': f'Missing required field: {field}',
                            'suggestion': f'Add "{field}" to dataset_description.json',
                            'affected_fields': [field],
                            'bids_level': 'dataset'
                        }
                        validator_info = self._link_to_bids_validator('dataset_description.json', issue['issue'])
                        if validator_info:
                            issue['validator_reference'] = validator_info
                        issues.append(issue)
                
                # Check content quality
                quality_issues = self._check_content_quality(desc_file, content, 'dataset_description')
                issues.extend(quality_issues)
                
            except json.JSONDecodeError:
                issue = {
                    'file': 'dataset_description.json',
                    'category': 'BIDS',
                    'severity': 'error',
                    'issue': 'Invalid JSON in dataset_description.json',
                    'suggestion': 'Fix JSON syntax errors',
                    'affected_fields': [],
                    'bids_level': 'dataset'
                }
                issues.append(issue)
        
        # Check README
        readme_file = join(self.bids_root, 'README')
        readme_md = join(self.bids_root, 'README.md')
        
        readme_path = None
        if exists(readme_file):
            readme_path = readme_file
        elif exists(readme_md):
            readme_path = readme_md
        
        if not readme_path:
            issue = {
                'file': 'README',
                'category': 'BIDS',
                'severity': 'warning',
                'issue': 'Missing README at BIDS root',
                'suggestion': 'Create README with dataset description, acquisition information, and instructions',
                'affected_fields': [],
                'bids_level': 'dataset'
            }
            validator_info = self._link_to_bids_validator('README', issue['issue'])
            if validator_info:
                issue['validator_reference'] = validator_info
            issues.append(issue)
        else:
            # Check README content quality
            try:
                with open(readme_path, 'r') as f:
                    content = f.read()
                quality_issues = self._check_content_quality(readme_path, content, 'README')
                issues.extend(quality_issues)
            except Exception:
                pass
        
        # Check participants.tsv
        participants_file = join(self.bids_root, 'participants.tsv')
        participants_json = join(self.bids_root, 'participants.json')
        
        if not exists(participants_file):
            issue = {
                'file': 'participants.tsv',
                'category': 'BIDS',
                'severity': 'warning',
                'issue': 'Missing participants.tsv',
                'suggestion': 'Create participants.tsv with at least: participant_id, age, sex',
                'affected_fields': [],
                'bids_level': 'dataset'
            }
            validator_info = self._link_to_bids_validator('participants.tsv', issue['issue'])
            if validator_info:
                issue['validator_reference'] = validator_info
            issues.append(issue)
        else:
            try:
                df = pd.read_csv(participants_file, sep='\t')
                if 'participant_id' not in df.columns:
                    issue = {
                        'file': 'participants.tsv',
                        'category': 'BIDS',
                        'severity': 'error',
                        'issue': 'Missing participant_id column',
                        'suggestion': 'Add participant_id column with format sub-<id>',
                        'affected_fields': ['participant_id'],
                        'bids_level': 'dataset'
                    }
                    validator_info = self._link_to_bids_validator('participants.tsv', issue['issue'])
                    if validator_info:
                        issue['validator_reference'] = validator_info
                    issues.append(issue)
                
                # Check for recommended columns
                recommended_cols = ['age', 'sex', 'group']
                missing_cols = [col for col in recommended_cols if col not in df.columns]
                if len(missing_cols) >= 2:
                    issues.append({
                        'file': 'participants.tsv',
                        'category': 'Documentation',
                        'severity': 'info',
                        'issue': f'Missing recommended columns: {missing_cols}',
                        'suggestion': 'Consider adding demographic information (age, sex) for better dataset documentation',
                        'affected_fields': missing_cols,
                        'bids_level': 'dataset'
                    })
            except Exception as e:
                issues.append({
                    'file': 'participants.tsv',
                    'category': 'BIDS',
                    'severity': 'warning',
                    'issue': f'Could not parse participants.tsv: {str(e)}',
                    'suggestion': 'Ensure participants.tsv is TSV format with tab separators',
                    'affected_fields': [],
                    'bids_level': 'dataset'
                })
        
        # Check for participants.json sidecar
        if exists(participants_file) and not exists(participants_json):
            issues.append({
                'file': 'participants.json',
                'category': 'Documentation',
                'severity': 'info',
                'issue': 'Missing participants.json sidecar',
                'suggestion': 'Create participants.json to describe participant columns and their metadata',
                'affected_fields': [],
                'bids_level': 'dataset'
            })
        
        # Check CHANGES file
        changes_file = join(self.bids_root, 'CHANGES')
        if not exists(changes_file):
            issues.append({
                'file': 'CHANGES',
                'category': 'Documentation',
                'severity': 'info',
                'issue': 'Missing CHANGES file',
                'suggestion': 'Create CHANGES file to document dataset version history',
                'affected_fields': [],
                'bids_level': 'dataset'
            })
        
        return issues

    def _load_bids_validator_results(self) -> None:
        """Load BIDS validator output if available."""
        bids_results_path = join(self.bids_root, 'bids_results.json')
        if exists(bids_results_path):
            try:
                with open(bids_results_path, 'r') as f:
                    self.bids_validator_output = json.load(f)
            except:
                self.bids_validator_output = None

    def _get_bids_hierarchy_level(self, file_path: str) -> str:
        """
        Determine the BIDS hierarchy level for a file path.
        
        Returns:
            'dataset', 'subject', 'session', or 'file' based on the path structure
        """
        if not file_path or file_path in ['dataset', 'multiple']:
            return 'dataset'
        
        # Parse BIDS entities from path
        import re
        has_subject = re.search(r'sub-([^_/]+)', file_path)
        has_session = re.search(r'ses-([^_/]+)', file_path)
        has_filename = '.' in file_path  # Has file extension
        
        if has_filename:
            return 'file'
        elif has_session:
            return 'session'
        elif has_subject:
            return 'subject'
        else:
            return 'dataset'

    def _link_to_bids_validator(self, file_path: str, issue_text: str) -> Optional[Dict[str, Any]]:
        """
        Find matching issue in bids_results.json for additional context.
        
        Returns:
            Dict with validator details if found, None otherwise
        """
        if not self.bids_validator_output:
            return None
        
        # Search for matching issues in BIDS validator output
        issues = self.bids_validator_output.get('issues', {}).get('errors', []) + \
                 self.bids_validator_output.get('issues', {}).get('warnings', [])
        
        for validator_issue in issues:
            # Check if the file path matches
            validator_files = validator_issue.get('files', [])
            if any(file_path in f.get('path', '') for f in validator_files):
                return {
                    'validator_code': validator_issue.get('key', ''),
                    'validator_reason': validator_issue.get('reason', ''),
                    'validator_link': f"https://neurostars.org/search?q={validator_issue.get('key', '')}"
                }
        
        return None

    def _check_readme_against_template(self) -> List[Dict[str, Any]]:
        """
        Compare README against BIDS template and identify missing sections.
        If README doesn't exist, offer to create it from template.
        
        Returns:
            List of issues
        """
        issues = []
        
        # Try to find README
        readme_path = None
        for candidate in [join(self.bids_root, 'README'), join(self.bids_root, 'README.md')]:
            if exists(candidate):
                readme_path = candidate
                break
        
        # Try to locate template in likely locations
        template_candidates = [
            join(Path(__file__).parent, '..', 'web', 'BIDS_README_template.md'),
            join(Path(__file__).parent.parent, 'web', 'BIDS_README_template.md'),
            '/opt/bidsifier/web/BIDS_README_template.md',
        ]
        
        template_content = None
        for template_path in template_candidates:
            if exists(template_path):
                try:
                    with open(template_path, 'r') as f:
                        template_content = f.read()
                    break
                except:
                    pass
        
        if not readme_path and template_content:
            # README doesn't exist - suggest creating from template
            issues.append({
                'file': 'README',
                'category': 'Documentation',
                'severity': 'warning',
                'issue': 'README can be created from BIDS template',
                'suggestion': 'Use BIDS_README_template.md to create a comprehensive README',
                'affected_fields': [],
                'bids_level': 'dataset',
                'template_available': True
            })
        elif readme_path and template_content:
            # README exists - compare against template sections
            try:
                with open(readme_path, 'r') as f:
                    readme_content = f.read()
                
                # Extract section headers from template
                template_sections = set()
                for line in template_content.split('\n'):
                    if line.startswith('## '):
                        template_sections.add(line[3:].strip().lower())
                
                # Check which sections are in README
                readme_sections_found = set()
                for line in readme_content.split('\n'):
                    if line.startswith('## ') or line.startswith('# '):
                        readme_sections_found.add(line.lstrip('#').strip().lower())
                
                # Find missing recommended sections
                missing = template_sections - readme_sections_found
                if missing and len(missing) >= 3:
                    issues.append({
                        'file': 'README',
                        'category': 'Documentation',
                        'severity': 'info',
                        'issue': f'README missing BIDS template sections',
                        'suggestion': f'Consider adding sections: {", ".join(list(missing)[:3])}',
                        'affected_fields': [],
                        'bids_level': 'dataset',
                        'missing_sections': list(missing)[:5]
                    })
            except Exception:
                pass

        return issues

    def _check_content_quality(self, file_path: str, content: str, file_type: str) -> List[Dict[str, Any]]:
        """
        Check if README or dataset_description content is sufficiently detailed.
        
        Args:
            file_path: Path to the file
            content: File content as string
            file_type: 'README' or 'dataset_description'
            
        Returns:
            List of content quality issues
        """
        issues = []
        
        if file_type == 'README':
            # Check README length and content
            if len(content) < 100:
                issues.append({
                    'file': 'README',
                    'category': 'Documentation',
                    'severity': 'warning',
                    'issue': 'README is too brief (< 100 characters)',
                    'suggestion': 'Expand README to include dataset overview, acquisition details, and usage instructions',
                    'affected_fields': [],
                    'bids_level': 'dataset'
                })
            
            # Check for key sections
            content_lower = content.lower()
            recommended_sections = {
                'dataset': ['dataset', 'data', 'overview'],
                'acquisition': ['acquisition', 'protocol', 'procedure', 'scanning'],
                'subjects': ['participant', 'subject'],
                'reference': ['reference', 'citation', 'publication']
            }
            
            missing_topics = []
            for topic, keywords in recommended_sections.items():
                if not any(kw in content_lower for kw in keywords):
                    missing_topics.append(topic)
            
            if len(missing_topics) >= 3:
                issues.append({
                    'file': 'README',
                    'category': 'Documentation',
                    'severity': 'info',
                    'issue': f'README missing recommended sections: {missing_topics}',
                    'suggestion': 'Consider adding sections for: dataset overview, acquisition details, participant info, and references',
                    'affected_fields': [],
                    'bids_level': 'dataset'
                })
        
        elif file_type == 'dataset_description':
            try:
                desc = json.loads(content)
                
                # Check for recommended optional fields
                recommended_fields = ['Authors', 'Acknowledgements', 'HowToAcknowledge', 
                                     'Funding', 'ReferencesAndLinks', 'DatasetDOI']
                missing_fields = [f for f in recommended_fields if f not in desc]
                
                if len(missing_fields) >= 4:
                    issues.append({
                        'file': 'dataset_description.json',
                        'category': 'Documentation',
                        'severity': 'info',
                        'issue': f'Missing recommended fields: {missing_fields[:3]}...',
                        'suggestion': 'Add optional fields for better dataset documentation (Authors, Funding, References, etc.)',
                        'affected_fields': missing_fields,
                        'bids_level': 'dataset'
                    })
                
                # Check Name field quality
                if 'Name' in desc:
                    name = desc['Name']
                    if len(name) < 5 or name.lower() in ['dataset', 'bids', 'test', 'data']:
                        issues.append({
                            'file': 'dataset_description.json',
                            'category': 'Documentation',
                            'severity': 'warning',
                            'issue': 'Dataset Name appears to be placeholder or too generic',
                            'suggestion': 'Use a descriptive name that identifies the study or dataset purpose',
                            'affected_fields': ['Name'],
                            'bids_level': 'dataset'
                        })
            
            except json.JSONDecodeError:
                pass  # Already caught by validate_dataset_structure
        
        return issues

    def validate_modality_metadata(self, bids_file_path: str, json_file_path: str) -> List[Dict[str, Any]]:
        """
        Validate modality-specific metadata from JSON sidecar.
        
        Args:
            bids_file_path: Path to BIDS data file (e.g., sub-01_task-rest_meg.fif)
            json_file_path: Path to corresponding JSON sidecar
        """
        issues = []
        
        if not exists(json_file_path):
            issues.append({
                'file': bids_file_path,
                'category': 'BIDS',
                'severity': 'error',
                'issue': f'Missing JSON sidecar: {json_file_path}',
                'suggestion': 'Create JSON sidecar with metadata',
                'affected_fields': []
            })
            return issues
        
        try:
            with open(json_file_path, 'r') as f:
                metadata = json.load(f)
        except json.JSONDecodeError:
            issues.append({
                'file': json_file_path,
                'category': 'BIDS',
                'severity': 'error',
                'issue': 'Invalid JSON in sidecar',
                'suggestion': 'Fix JSON syntax errors',
                'affected_fields': []
            })
            return issues
        
        # Check required fields for modality
        modality_key = f'{self.modality}_json'
        required_fields = BIDS_REQUIRED_FIELDS.get(self.modality, {}).get(modality_key, [])
        
        for field in required_fields:
            if field not in metadata or metadata[field] is None:
                issues.append({
                    'file': bids_file_path,
                    'category': 'Metadata',
                    'severity': 'error',
                    'issue': f'Missing required field: {field}',
                    'suggestion': f'Add "{field}" to {json_file_path}',
                    'affected_fields': [field]
                })
        
        # Validate field constraints
        for field, value in metadata.items():
            if field in BIDS_CONSTRAINTS:
                constraint = BIDS_CONSTRAINTS[field]
                issue = self._check_constraint(field, value, constraint)
                if issue:
                    issue['file'] = bids_file_path
                    issue['affected_fields'] = [field]
                    issues.append(issue)
        
        return issues

    def validate_signal_quality(self, raw_file_path: str) -> List[Dict[str, Any]]:
        """
        Detect signal quality issues: noise, saturation, baseline drift.
        
        Args:
            raw_file_path: Path to raw MEG/EEG file
        """
        issues = []
        
        if not exists(raw_file_path):
            return issues
        
        try:
            # Read raw file based on format
            if raw_file_path.endswith('.fif'):
                raw = mne.io.read_raw_fif(raw_file_path, preload=False, verbose='error')
            else:
                return issues
            
            # Check sampling frequency reasonableness
            fs = raw.info['sfreq']
            if fs < 100:
                issues.append({
                    'file': raw_file_path,
                    'category': 'Quality',
                    'severity': 'warning',
                    'issue': f'Low sampling frequency: {fs} Hz',
                    'suggestion': 'Verify sampling frequency is appropriate for data type',
                    'affected_fields': ['SamplingFrequency']
                })
            
            # Check channel counts by type
            n_meg = len(raw.info['chs']) if raw.info['chs'] else 0
            if n_meg < 100 and self.modality == 'meg':
                issues.append({
                    'file': raw_file_path,
                    'category': 'Quality',
                    'severity': 'warning',
                    'issue': f'Unusually low MEG channel count: {n_meg}',
                    'suggestion': 'Verify that all channels were recorded',
                    'affected_fields': ['NumberOfChannels']
                })
            
            # Check data range for obvious saturation
            if hasattr(raw, 'times') and len(raw.times) > 0:
                # Sample check: read first 10 seconds
                duration = min(10.0, raw.times[-1] - raw.times[0])
                if duration > 0:
                    try:
                        data, times = raw[:, :int(raw.info['sfreq'] * min(10, duration))]
                        
                        # Check for extreme values suggesting saturation
                        for ch_idx, ch_data in enumerate(data):
                            if len(ch_data) > 0:
                                max_val = abs(ch_data).max()
                                # Typical MEG range is pT, typical EEG range is μV
                                if self.modality == 'meg' and max_val > 1e-10:
                                    issues.append({
                                        'file': raw_file_path,
                                        'category': 'Quality',
                                        'severity': 'warning',
                                        'issue': f'High data amplitude detected (possible saturation)',
                                        'suggestion': 'Review channels for clipping or sensor malfunction',
                                        'affected_fields': [raw.info['chs'][ch_idx]['ch_name']]
                                    })
                                    break
                    except Exception:
                        pass
        
        except Exception as e:
            issues.append({
                'file': raw_file_path,
                'category': 'Quality',
                'severity': 'warning',
                'issue': f'Could not analyze signal quality: {str(e)[:100]}',
                'suggestion': 'Verify file is readable and format is correct',
                'affected_fields': []
            })
        
        return issues

    def detect_metadata_inconsistencies(self, conversion_table: pd.DataFrame) -> List[Dict[str, Any]]:
        """
        Detect inconsistencies in metadata across dataset.
        
        Args:
            conversion_table: Conversion table DataFrame
        """
        issues = []
        
        if conversion_table.empty:
            return issues
        
        # Check for inconsistent sampling rates across subjects
        if 'sampling_rate' in conversion_table.columns:
            rates = conversion_table['sampling_rate'].dropna().unique()
            if len(rates) > 1:
                issues.append({
                    'file': 'multiple',
                    'category': 'Metadata',
                    'severity': 'warning',
                    'issue': f'Inconsistent sampling rates detected: {rates}',
                    'suggestion': 'Verify that all subjects used same acquisition parameters',
                    'affected_fields': ['SamplingFrequency'],
                    'bids_level': 'dataset'
                })
        
        # Note: Missing sessions/tasks checks are handled by QA agent's analyze_completed_dataset()
        # to avoid duplicate issue generation
        
        return issues

    def _check_constraint(self, field: str, value: Any, constraint: Dict) -> Optional[Dict[str, Any]]:
        """
        Check if value satisfies constraint. Returns issue dict if violated, None otherwise.
        """
        if value is None:
            return None
        
        # Type check
        expected_type = constraint.get('type', 'object')
        if expected_type == 'number' and not isinstance(value, (int, float)):
            return {
                'category': 'Metadata',
                'severity': 'warning',
                'issue': f'Field {field} should be number, got {type(value).__name__}',
                'suggestion': f'Ensure {field} is numeric value',
                'affected_fields': []
            }
        
        # Value range check
        if expected_type in ('number', 'integer'):
            if 'min' in constraint and value < constraint['min']:
                return {
                    'category': 'Metadata',
                    'severity': 'warning',
                    'issue': f'Field {field}={value} below minimum {constraint["min"]}',
                    'suggestion': f'Verify {field} is correct',
                    'affected_fields': []
                }
            if 'max' in constraint and value > constraint['max']:
                return {
                    'category': 'Metadata',
                    'severity': 'warning',
                    'issue': f'Field {field}={value} above maximum {constraint["max"]}',
                    'suggestion': f'Verify {field} is correct',
                    'affected_fields': []
                }
        
        # Allowed values check
        if 'values' in constraint and value not in constraint['values']:
            return {
                'category': 'Metadata',
                'severity': 'warning',
                'issue': f'Field {field}={value} not in allowed values {constraint["values"]}',
                'suggestion': f'Use one of: {", ".join(map(str, constraint["values"]))}',
                'affected_fields': []
            }
        
        return None

    def run_full_validation(self, conversion_table: Optional[pd.DataFrame] = None) -> Dict[str, List[Dict[str, Any]]]:
        """
        Run full validation suite and return comprehensive report.
        
        Args:
            conversion_table: Optional conversion table for additional checks
            
        Returns:
            Dict with validation results organized by category
        """
        results = {
            'dataset_structure': self.validate_dataset_structure(),
            'metadata_consistency': self.detect_metadata_inconsistencies(conversion_table) if conversion_table is not None else [],
            'all_issues': []
        }
        
        results['all_issues'] = results['dataset_structure'] + results['metadata_consistency']
        
        return results
