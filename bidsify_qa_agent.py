"""
BIDS QA Agent — AI-powered quality assessment for completed MEG/EEG BIDS datasets.
Performs post-conversion validation to detect dataset-level inconsistencies:
  - Missing sessions for subjects
  - Incomplete task coverage across subjects
  - Metadata inconsistencies
  - BIDS compliance validation

Integrates optional local LLM (ollama/llama.cpp) for intelligent recommendations.
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
import pandas as pd

from bidsify_bids_schema import BIDSSchemaValidator


class BIDSQAAgent:
    """
    AI-powered QA agent for BIDS datasets.
    Performs automated quality checks and generates structured findings.
    """

    def __init__(self, bids_root: str, config: dict, enable_llm: bool = False):
        """
        Initialize QA agent.
        
        Args:
            bids_root: Path to BIDS dataset root
            config: Configuration dictionary
            enable_llm: Whether to use local LLM for advanced analysis
        """
        self.bids_root = bids_root
        self.config = config
        self.enable_llm = enable_llm
        self.schema_validator = BIDSSchemaValidator(bids_root, config)
        self.findings = []
        self.summary = {}
        
        if enable_llm:
            self._init_llm()

    def _init_llm(self):
        """Initialize connection to local LLM (ollama or llama.cpp)."""
        try:
            import requests
            self.llm_available = True
            # Check if ollama is running locally
            try:
                resp = requests.get('http://localhost:11434/api/tags', timeout=2)
                self.llm_endpoint = 'http://localhost:11434'
                self.llm_type = 'ollama'
            except:
                # Try llama.cpp
                try:
                    resp = requests.get('http://localhost:8000/v1/models', timeout=2)
                    self.llm_endpoint = 'http://localhost:8000'
                    self.llm_type = 'llama.cpp'
                except:
                    self.llm_available = False
                    print("[WARN] Local LLM not available. Running validation-only mode.")
        except ImportError:
            self.llm_available = False

    def _call_llm(self, prompt: str) -> Optional[str]:
        """
        Call local LLM with structured prompt.
        Provides context about BIDS, MEG/EEG data, and current findings.
        """
        if not self.llm_available or not self.enable_llm:
            return None
        
        try:
            import requests
            
            if self.llm_type == 'ollama':
                response = requests.post(
                    f'{self.llm_endpoint}/api/generate',
                    json={
                        'model': 'neural-chat',  # or 'mistral', 'neural-chat'
                        'prompt': prompt,
                        'stream': False,
                        'temperature': 0.3,
                        'num_predict': 500,
                    },
                    timeout=30
                )
                if response.status_code == 200:
                    return response.json().get('response', '')
            
            elif self.llm_type == 'llama.cpp':
                response = requests.post(
                    f'{self.llm_endpoint}/v1/completions',
                    json={
                        'prompt': prompt,
                        'max_tokens': 500,
                        'temperature': 0.3,
                    },
                    timeout=30
                )
                if response.status_code == 200:
                    data = response.json()
                    if 'choices' in data and len(data['choices']) > 0:
                        return data['choices'][0].get('text', '')
        except Exception as e:
            print(f"[WARN] LLM call failed: {e}")
        
        return None

    def analyze_dataset(self, conversion_table: Optional[pd.DataFrame] = None) -> Dict[str, Any]:
        """
        Run comprehensive QA analysis on entire dataset.
        Focuses on post-conversion validation and dataset-level consistency.
        
        Args:
            conversion_table: Optional conversion table for additional context
            
        Returns:
            Dictionary with findings, summary statistics, and recommendations
        """
        self.findings = []
        self.summary = {
            'dataset': os.path.basename(self.bids_root),
            'timestamp': datetime.now().isoformat(),
            'modality': self.config.get('Modality', 'meg').lower(),
            'total_issues': 0,
            'severity_counts': {'error': 0, 'warning': 0, 'info': 0},
            'categories': {},
            'recommendations': []
        }
        
        # Run schema validation on BIDS output
        validation_results = self.schema_validator.run_full_validation(conversion_table)
        
        for issue in validation_results['all_issues']:
            self._process_finding(issue)
        
        # Analyze completed conversions for dataset-level inconsistencies
        if conversion_table is not None and not conversion_table.empty:
            dataset_issues = self.analyze_completed_dataset(conversion_table)
            for issue in dataset_issues:
                self._process_finding(issue)
        
        # Derive recommendations using AI if available
        if self.enable_llm and self.findings:
            recommendations = self._generate_recommendations(conversion_table)
            self.summary['recommendations'] = recommendations
        
        # Calculate summary statistics
        self._update_summary()
        
        return {
            'findings': self.findings,
            'summary': self.summary,
            'timestamp': datetime.now().isoformat()
        }

    def analyze_completed_dataset(self, conversion_table: pd.DataFrame) -> List[Dict[str, Any]]:
        """
        Analyze completed conversions for post-processing inconsistencies.
        Focuses on dataset-level issues like missing sessions, incomplete subjects, etc.
        
        Args:
            conversion_table: Conversion table DataFrame with completed conversions
            
        Returns:
            List of dataset-level issues found
        """
        issues = []
        
        if conversion_table.empty:
            return issues
        
        # Only analyze processed/successful conversions
        completed = conversion_table[conversion_table['status'] == 'processed']
        if completed.empty:
            return issues
        
        # Detect subject-level inconsistencies
        all_subjects = completed['participant_to'].dropna().unique()
        all_sessions = completed['session_to'].dropna().unique()
        all_tasks = completed['task'].dropna().unique()
        
        # Check for incomplete sessions per subject
        if len(all_sessions) > 1:
            for subject in all_subjects:
                subj_data = completed[completed['participant_to'] == subject]
                subj_sessions = subj_data['session_to'].dropna().unique()
                
                if len(subj_sessions) < len(all_sessions):
                    missing_sessions = set(all_sessions) - set(subj_sessions)
                    issues.append({
                        'file': f"sub-{subject}",
                        'category': 'Dataset Consistency',
                        'severity': 'warning',
                        'issue': f'Subject missing sessions: {", ".join(map(str, missing_sessions))}',
                        'suggestion': f'Verify if sub-{subject} should have all sessions or mark as expected',
                        'affected_fields': ['session'],
                        'bids_level': 'subject'
                    })
        
        # Check for incomplete tasks at modality level (subject/session/datatype)
        # This catches cases where, for example, EEG has missing tasks while MEG does not.
        if 'datatype' in completed.columns:
            datatypes = completed['datatype'].dropna().unique()
            for datatype in datatypes:
                modality_data = completed[completed['datatype'] == datatype]
                modality_tasks = modality_data['task'].dropna().unique()
                if len(modality_tasks) <= 1:
                    continue

                modality_sessions = modality_data['session_to'].dropna().unique()
                for session in modality_sessions:
                    sess_modality = modality_data[modality_data['session_to'] == session]
                    subjects_in_session = sess_modality['participant_to'].dropna().unique()

                    for subject in subjects_in_session:
                        subj_sess_mod = sess_modality[sess_modality['participant_to'] == subject]
                        subj_tasks = subj_sess_mod['task'].dropna().unique()

                        if len(subj_tasks) < len(modality_tasks):
                            missing_tasks = sorted(set(modality_tasks) - set(subj_tasks))
                            issues.append({
                                'file': f"sub-{subject}/ses-{session}/{datatype}",
                                'category': 'Dataset Consistency',
                                'severity': 'warning',
                                'issue': f'Modality missing tasks: {", ".join(missing_tasks)}',
                                'suggestion': f'Verify if sub-{subject}/ses-{session}/{datatype} should include all {datatype.upper()} tasks',
                                'affected_fields': ['task', 'datatype'],
                                'bids_level': 'modality'
                            })
        elif len(all_tasks) > 1:
            # Fallback when datatype is unavailable
            for session in all_sessions:
                sess_data = completed[completed['session_to'] == session]
                subjects_in_session = sess_data['participant_to'].dropna().unique()
                for subject in subjects_in_session:
                    subj_sess_data = sess_data[sess_data['participant_to'] == subject]
                    subj_sess_tasks = subj_sess_data['task'].dropna().unique()
                    if len(subj_sess_tasks) < len(all_tasks):
                        missing_tasks = sorted(set(all_tasks) - set(subj_sess_tasks))
                        issues.append({
                            'file': f"sub-{subject}/ses-{session}",
                            'category': 'Dataset Consistency',
                            'severity': 'warning',
                            'issue': f'Session missing tasks: {", ".join(missing_tasks)}',
                            'suggestion': f'Verify if sub-{subject}/ses-{session} should have all tasks',
                            'affected_fields': ['task'],
                            'bids_level': 'session'
                        })
        
        # Check for acquisition parameter consistency
        if 'datatype' in completed.columns:
            datatypes = completed['datatype'].dropna().unique()
            if len(datatypes) > 1:
                issues.append({
                    'file': 'dataset',
                    'category': 'Dataset Consistency',
                    'severity': 'info',
                    'issue': f'Multiple datatypes detected: {", ".join(datatypes)}',
                    'suggestion': 'Verify mixed modalities (MEG/EEG) are intentional',
                    'affected_fields': ['datatype'],
                    'bids_level': 'dataset'
                })
        
        return issues

    def _generate_recommendations(self, conversion_table: Optional[pd.DataFrame]) -> List[Dict[str, Any]]:
        """
        Use AI to generate actionable recommendations based on findings.
        """
        recommendations = []
        
        if not self.findings:
            return recommendations
        
        # Group issues by category
        issues_by_category = {}
        for finding in self.findings:
            cat = finding.get('category', 'Other')
            if cat not in issues_by_category:
                issues_by_category[cat] = []
            issues_by_category[cat].append(finding)
        
        # Build context prompt
        prompt = f"""You are a BIDS data quality expert. Analyze these findings and provide 3-5 actionable recommendations.

Dataset: {self.summary['dataset']}
Modality: {self.summary['modality']}
Total Issues: {self.summary['total_issues']}

Issues by category:
{json.dumps(issues_by_category, indent=2)}

Provide JSON array of recommendations in this format:
[{{"priority": "high"|"medium"|"low", "action": "brief actionable step", "impact": "expected improvement"}}]

Only JSON array, no other text."""
        
        response = self._call_llm(prompt)
        if response:
            try:
                # Extract JSON from response
                import re
                json_match = re.search(r'\[.*\]', response, re.DOTALL)
                if json_match:
                    recs = json.loads(json_match.group())
                    recommendations = recs if isinstance(recs, list) else []
            except json.JSONDecodeError:
                pass
        
        return recommendations

    def _process_finding(self, issue: Dict[str, Any]) -> None:
        """
        Process individual finding and update internal state.
        """
        # Ensure required fields
        issue.setdefault('severity', 'info')
        issue.setdefault('category', 'Other')
        
        # Add BIDS hierarchy level if not present
        if 'bids_level' not in issue:
            issue['bids_level'] = self.schema_validator._get_bids_hierarchy_level(issue.get('file', ''))
        
        self.findings.append(issue)
        
        # Update severity counts
        severity = issue.get('severity', 'info')
        if severity in self.summary['severity_counts']:
            self.summary['severity_counts'][severity] += 1

    def _update_summary(self) -> None:
        """Update summary statistics."""
        self.summary['total_issues'] = len(self.findings)
        
        # Count by category
        for finding in self.findings:
            cat = finding.get('category', 'Other')
            if cat not in self.summary['categories']:
                self.summary['categories'][cat] = 0
            self.summary['categories'][cat] += 1

    def format_report(self, detailed: bool = False) -> str:
        """
        Format findings as human-readable report.
        
        Args:
            detailed: If True, include all details; if False, summary only
            
        Returns:
            Formatted report string
        """
        lines = []
        lines.append("=" * 70)
        lines.append("BIDS QA REPORT")
        lines.append("=" * 70)
        lines.append(f"Dataset: {self.summary['dataset']}")
        lines.append(f"Timestamp: {self.summary['timestamp']}")
        lines.append(f"Modality: {self.summary['modality']}")
        lines.append("")
        
        lines.append("SUMMARY")
        lines.append("-" * 70)
        lines.append(f"Total Issues: {self.summary['total_issues']}")
        lines.append(f"Errors: {self.summary['severity_counts']['error']}, "
                     f"Warnings: {self.summary['severity_counts']['warning']}, "
                     f"Info: {self.summary['severity_counts']['info']}")
        lines.append("")
        
        if self.summary['categories']:
            lines.append("Issues by Category:")
            for cat, count in sorted(self.summary['categories'].items()):
                lines.append(f"  {cat}: {count}")
            lines.append("")
        
        if detailed and self.findings:
            lines.append("DETAILED FINDINGS")
            lines.append("-" * 70)
            for i, finding in enumerate(self.findings, 1):
                lines.append(f"\n{i}. [{finding.get('severity', 'info').upper()}] {finding.get('issue', 'Unknown')}")
                lines.append(f"   Category: {finding.get('category', 'Other')}")
                lines.append(f"   File: {finding.get('file', 'N/A')}")
                if finding.get('suggestion'):
                    lines.append(f"   Suggestion: {finding['suggestion']}")
        
        if self.summary['recommendations']:
            lines.append("\nRECOMMENDATIONS")
            lines.append("-" * 70)
            for i, rec in enumerate(self.summary['recommendations'], 1):
                pri = rec.get('priority', 'medium').upper()
                lines.append(f"\n{i}. [{pri}] {rec.get('action', 'No action')}")
                if rec.get('impact'):
                    lines.append(f"   Impact: {rec['impact']}")
        
        lines.append("\n" + "=" * 70)
        return "\n".join(lines)

        for deviant in deviants:
            if 'row_index' in deviant and deviant.get('status') == 'check':
                idx = deviant['row_index']
                if idx in conversion_table.index:
                    conversion_table.at[idx, 'status'] = 'check'
        
        return conversion_table
