#!/usr/bin/env python3
"""Monitor host capacity and remove only individually approved retired artifacts.

Run as root from launchd. Configuration and its parent must be owned by root;
the state directory must be private to root. This program never stops services.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import statistics
import subprocess
import sys
import tempfile
import time

GIB = 1024 ** 3
ROOT_UID = 0
DAY = 86400


class GuardError(Exception):
    """A failed safety prerequisite; do not delete anything dependent on it."""


def integer(value, name, minimum=0):
    """Require an actual bounded integer, rejecting booleans and numeric strings."""
    if type(value) is not int or not minimum <= value <= 2 ** 63 - 1:
        raise GuardError(f"Invalid {name}")
    return value


def checked_path(value, missing=False):
    """Validate a canonical absolute path without traversing symbolic links."""
    if not isinstance(value, str) or not value.startswith('/') or '\x00' in value:
        raise GuardError('Expected an absolute path')
    path = Path(value)
    if value != str(path) or '..' in path.parts or path == Path('/'):
        raise GuardError('Noncanonical or root path refused')
    for part in reversed((path, *path.parents)):
        try:
            metadata = part.lstat()
        except FileNotFoundError:
            if missing:
                return path
            raise GuardError(f'Missing required path: {part}') from None
        if stat.S_ISLNK(metadata.st_mode):
            raise GuardError(f'Symbolic link refused: {part}')
    return path


def trusted(path, directory=False, private=False):
    """Require root ownership and safe permissions for configuration/state."""
    info = path.stat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & (0o077 if private else 0o022):
        raise GuardError(f'Unsafe ownership, type or permissions: {path}')


def trusted_retirement(config, path):
    """Require a single-link root-owned file inside a private trusted intake."""
    intake = checked_path(config['retirement_root'])
    if path.parent != intake:
        raise GuardError('Retired files must be direct children of retirement_root')
    trusted(intake, directory=True, private=True)
    for ancestor in intake.parents:
        trusted(ancestor, directory=True)
    trusted(path)
    if path.lstat().st_nlink != 1:
        raise GuardError('Retired files must have exactly one hard link')


def read_json(path, default=None):
    """Read bounded JSON, using a default only when the file is absent."""
    if not path.exists():
        return default
    checked_path(str(path))
    if path.stat().st_size > 1024 * 1024:
        raise GuardError(f'JSON file exceeds size limit: {path}')
    try:
        return json.loads(path.read_text())
    except (ValueError, UnicodeError):
        raise GuardError(f'Malformed JSON: {path}') from None


def load_config(filename):
    """Validate the complete allowlist before any mutation is considered."""
    path = checked_path(filename)
    trusted(path)
    trusted(path.parent, directory=True)
    config = read_json(path)
    required = {'version', 'filesystem_path', 'state_dir', 'protected_paths', 'env_files', 'retired_artifacts'}
    optional = {'warning_free_bytes', 'urgent_free_bytes', 'reserve_bytes', 'public_status_path', 'retirement_root'}
    if not isinstance(config, dict) or not required <= config.keys() or config.keys() - required - optional:
        raise GuardError('Missing or unknown configuration fields')
    if type(config['version']) is not int or config['version'] != 1:
        raise GuardError('Unsupported configuration version')
    config['retirement_root'] = str(checked_path(config.get('retirement_root', '/Library/PolkaswapStorage/retired'), missing=True))
    for name in ('protected_paths', 'env_files', 'retired_artifacts'):
        if not isinstance(config[name], list) or (name != 'retired_artifacts' and not config[name]):
            raise GuardError(f'Invalid {name}')
    checked_path(config['filesystem_path'])
    state = checked_path(config['state_dir'])
    trusted(state, directory=True, private=True)
    if 'public_status_path' in config:
        public = checked_path(config['public_status_path'], missing=True)
        trusted(public.parent, directory=True)
        if public.exists():
            trusted(public)
    config['warning_free_bytes'] = integer(config.get('warning_free_bytes', 150 * GIB), 'warning_free_bytes', 1)
    config['urgent_free_bytes'] = integer(config.get('urgent_free_bytes', 75 * GIB), 'urgent_free_bytes', 1)
    config['reserve_bytes'] = integer(config.get('reserve_bytes', 75 * GIB), 'reserve_bytes', 1)
    if config['urgent_free_bytes'] >= config['warning_free_bytes']:
        raise GuardError('Urgent threshold must be below warning threshold')
    for artifact in config['retired_artifacts']:
        if not isinstance(artifact, dict) or set(artifact) - {'path', 'expires_at', 'device', 'inode', 'sha256'}:
            raise GuardError('Invalid retired artifact fields')
        if not {'path', 'expires_at', 'device', 'inode'} <= artifact.keys():
            raise GuardError('Incomplete retired artifact')
        checked_path(artifact['path'], missing=True)
        integer(artifact['device'], 'device')
        integer(artifact['inode'], 'inode', 1)
        expiry(artifact['expires_at'])
        if 'sha256' in artifact and not re.fullmatch('[a-f0-9]{64}', str(artifact['sha256'])):
            raise GuardError('Invalid artifact SHA-256')
    config['_config_path'] = str(path)
    protections(config)
    return config


def expiry(value):
    """Parse an unambiguous UTC expiry rather than interpreting local time."""
    if not isinstance(value, str) or not value.endswith('Z'):
        raise GuardError('Expiry must be an ISO8601 UTC timestamp ending in Z')
    try:
        return dt.datetime.fromisoformat(value[:-1] + '+00:00').timestamp()
    except ValueError:
        raise GuardError('Invalid expiry timestamp') from None


def protections(config):
    """Read live database paths literally; never source or expand env files."""
    paths = [checked_path(p) for p in config['protected_paths']]
    paths += [checked_path(config['_config_path']), checked_path(config['state_dir'])]
    if 'public_status_path' in config:
        paths.append(checked_path(config['public_status_path'], missing=True))
    for filename in config['env_files']:
        env = checked_path(filename)
        if not env.is_file() or env.stat().st_size > 1024 * 1024:
            raise GuardError('Invalid environment file')
        matches = re.findall(r'^\s*(?:export\s+)?ROCKSDB_PATH\s*=\s*(.*?)\s*$', env.read_text(), re.M)
        if len(matches) != 1:
            raise GuardError(f'Expected one ROCKSDB_PATH in {env}')
        value = matches[0]
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if any(c in value for c in '$`\\\n\r'):
            raise GuardError('Dynamic ROCKSDB_PATH expressions are refused')
        paths.extend((env, checked_path(value)))
    return paths


def overlaps(left, right):
    """Protect both descendants and ancestors of every protected location."""
    return left == right or left in right.parents or right in left.parents


def no_open_handles(path):
    """Use root lsof; only a clean no-match result permits deletion."""
    binary = next((p for p in ('/usr/sbin/lsof', '/usr/bin/lsof') if Path(p).is_file()), None)
    if binary is None:
        raise GuardError('lsof is unavailable')
    args = [binary, '-nP', '-F', 'p', '--', str(path)]
    try:
        result = subprocess.run(args, capture_output=True, timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise GuardError('lsof could not verify open handles') from None
    if result.returncode != 1 or result.stdout or result.stderr:
        raise GuardError(f'Open handles or lsof verification failure: {path}')


def validate_artifact(config, artifact, now):
    """Revalidate identity and current protections immediately before removal."""
    path = checked_path(artifact['path'], missing=True)
    protected = protections(config)
    if any(overlaps(path, item) for item in protected):
        raise GuardError(f'Artifact overlaps protected data: {path}')
    if not path.exists():
        return None
    if now < expiry(artifact['expires_at']):
        return None
    info = path.lstat()
    device = checked_path(config['filesystem_path']).stat().st_dev
    if (info.st_dev, info.st_ino) != (artifact['device'], artifact['inode']) or info.st_dev != device:
        raise GuardError(f'Artifact identity or filesystem mismatch: {path}')
    if not stat.S_ISREG(info.st_mode):
        raise GuardError('Directory and special-file cleanup is disabled')
    if 'sha256' not in artifact:
        raise GuardError('Regular file cleanup requires SHA-256')
    trusted_retirement(config, path)
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != artifact['sha256']:
        raise GuardError('Artifact SHA-256 mismatch')
    no_open_handles(path)
    after = path.lstat()
    if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise GuardError('Artifact changed during open-handle verification')
    return path


def remove_artifact(config, artifact, now):
    """Anchor final deletion to the verified parent directory's open descriptor."""
    candidate = checked_path(artifact['path'], missing=True)
    parent = candidate.parent
    expected_parent = parent.stat() if candidate.exists() else None
    path = validate_artifact(config, artifact, now)
    if path is None:
        return False
    if expected_parent is None:
        raise GuardError('Artifact appeared during verification')
    # Re-read dynamic protections and identity after the potentially slow lsof.
    if any(overlaps(path, item) for item in protections(config)):
        raise GuardError('Protection changed during verification')
    checked_path(str(path))
    trusted_retirement(config, path)
    descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened_parent = os.fstat(descriptor)
        if (opened_parent.st_dev, opened_parent.st_ino) != (expected_parent.st_dev, expected_parent.st_ino):
            raise GuardError('Artifact parent identity changed during verification')
        # Recheck ancestors after opening, then use only the anchored descriptor.
        current_parent = checked_path(str(parent)).stat()
        if (current_parent.st_dev, current_parent.st_ino) != (opened_parent.st_dev, opened_parent.st_ino):
            raise GuardError('Artifact parent path changed during verification')
        info = os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
        if (info.st_dev, info.st_ino) != (artifact['device'], artifact['inode']) or not stat.S_ISREG(info.st_mode):
            raise GuardError('Artifact identity changed during verification')
        if info.st_uid != ROOT_UID or info.st_mode & 0o022 or info.st_nlink != 1:
            raise GuardError('Artifact ownership or permissions changed during verification')
        os.unlink(path.name, dir_fd=descriptor)
    finally:
        os.close(descriptor)
    return True


def disk_sample(path, now):
    """Measure bytes actually available to applications, not df percentages."""
    fs = os.statvfs(path)
    return {'time': now, 'free_bytes': fs.f_bavail * fs.f_frsize, 'total_bytes': fs.f_blocks * fs.f_frsize}


def assess(samples, config):
    """Use day-long observations and six-hour medians to resist growth spikes."""
    current = samples[-1]
    trend = None
    uninterrupted = all(0 < b['time'] - a['time'] <= 1800 for a, b in zip(samples, samples[1:]))
    if len(samples) >= 288 and uninterrupted and current['time'] - samples[0]['time'] >= DAY:
        oldest = [x for x in samples if x['time'] <= samples[0]['time'] + DAY / 4]
        newest = [x for x in samples if x['time'] >= current['time'] - DAY / 4]
        if len(oldest) >= 12 and len(newest) >= 12:
            elapsed = statistics.median(x['time'] for x in newest) - statistics.median(x['time'] for x in oldest)
            loss = statistics.median(x['free_bytes'] for x in oldest) - statistics.median(x['free_bytes'] for x in newest)
            if elapsed > 0 and loss > 0:
                trend = current['free_bytes'] / (loss / elapsed) / DAY
    free = current['free_bytes']
    severity = 'urgent' if free <= config['urgent_free_bytes'] else 'warning' if free <= config['warning_free_bytes'] or trend is not None and trend < 7 else 'ok'
    return {**current, 'severity': severity, 'days_to_full': trend}


def atomic_json(path, value, mode=0o600):
    """Atomically replace private status/history after flushing the full body."""
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix='.storage-')
    try:
        with os.fdopen(descriptor, 'w') as stream:
            os.fchmod(stream.fileno(), mode)
            json.dump(value, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def record_event(state, event):
    """Keep at most 200 recent deletion/alert events in bounded JSONL form."""
    path = state / 'events.jsonl'
    existing = []
    if path.exists():
        checked_path(str(path))
        if path.stat().st_size > 256 * 1024:
            raise GuardError('Event log exceeds size bound')
        existing = path.read_text().splitlines()[-199:]
    content = '\n'.join([*existing, json.dumps(event, separators=(',', ':'))]) + '\n'
    if len(content.encode()) > 256 * 1024:
        raise GuardError('Event exceeds size bound')
    descriptor, temporary = tempfile.mkstemp(dir=state, prefix='.events-')
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(config, dry_run=False, now=None):
    """Check capacity, process at most five vetted retirements, and report changes."""
    now = time.time() if now is None else now
    state = Path(config['state_dir'])
    history = read_json(state / 'history.json', [])
    if not isinstance(history, list) or any(not isinstance(x, dict) or set(x) != {'time', 'free_bytes', 'total_bytes'} or any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in x.values()) for x in history):
        raise GuardError('Malformed history')
    history = sorted((x for x in history if now - 7 * DAY <= x['time'] < now), key=lambda x: x['time'])[-2015:]
    plans, errors = [], []
    for artifact in config['retired_artifacts']:
        if len(plans) == 5:
            break
        try:
            if dry_run:
                removed = validate_artifact(config, artifact, now) is not None
            else:
                removed = remove_artifact(config, artifact, now)
            if removed:
                plans.append(artifact['path'])
                if not dry_run:
                    record_event(state, {'time': now, 'event': 'removed', 'path': artifact['path']})
        except (GuardError, OSError) as error:
            errors.append(str(error))
    history.append(disk_sample(config['filesystem_path'], now))
    status = {**assess(history, config), 'dry_run': dry_run, 'artifacts': plans, 'cleanup_errors': errors}
    previous = read_json(state / 'status.json', {})
    if not isinstance(previous, dict) or type(previous.get('last_notified', 0)) not in (int, float) or not math.isfinite(previous.get('last_notified', 0)):
        raise GuardError('Malformed previous status')
    if not dry_run:
        notify = previous.get('severity') != status['severity'] or errors != previous.get('cleanup_errors', []) or bool(previous.get('alert_delivery_error')) or (status['severity'] != 'ok' or errors) and now - previous.get('last_notified', 0) >= DAY
        status['last_notified'] = previous.get('last_notified', 0)
        if notify:
            message = json.dumps(status, separators=(',', ':'))
            try:
                subprocess.run(['/usr/bin/logger', '-p', 'daemon.warning' if status['severity'] != 'ok' or errors else 'daemon.notice', '-t', 'polkaswap-storage-guard', message], check=True, timeout=10)
                status['last_notified'] = now
                record_event(state, {'time': now, 'event': 'notification', 'severity': status['severity']})
            except (OSError, subprocess.SubprocessError) as error:
                status['alert_delivery_error'] = f'Alert delivery failed: {type(error).__name__}'
                errors.append(status['alert_delivery_error'])
        atomic_json(state / 'history.json', history)
        atomic_json(state / 'status.json', status)
        if 'public_status_path' in config:
            public = {key: status[key] for key in ('time', 'free_bytes', 'total_bytes', 'severity', 'days_to_full')}
            public.update(cleanup_count=len(plans), cleanup_error_count=len(errors))
            if status.get('alert_delivery_error'):
                public['alert_delivery_error'] = status['alert_delivery_error']
            atomic_json(Path(config['public_status_path']), public, 0o644)
    return status


def check_space(config, required):
    """Refuse heavy work unless requested bytes plus the reserve remain free."""
    integer(required, 'required_bytes')
    sample = disk_sample(config['filesystem_path'], time.time())
    need = required + config['reserve_bytes']
    return {**sample, 'required_bytes': required, 'reserve_bytes': config['reserve_bytes'], 'sufficient': sample['free_bytes'] >= need}


def main():
    """Provide scheduled monitoring and a read-only maintenance preflight."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('run', 'check-space'))
    parser.add_argument('--config', required=True)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--required-bytes', type=int)
    args = parser.parse_args()
    try:
        if os.geteuid() != ROOT_UID:
            raise GuardError('Root is required for complete open-handle verification')
        config = load_config(args.config)
        if args.command == 'check-space':
            result = check_space(config, args.required_bytes)
        elif args.dry_run:
            result = run(config, dry_run=True)
        else:
            lock_path = Path(config['state_dir']) / 'guard.lock'
            descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'r+') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = run(config)
        print(json.dumps(result, separators=(',', ':')))
        return 2 if result.get('cleanup_errors') else 1 if result.get('sufficient') is False else 0
    except (GuardError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        if not args.dry_run:
            try:
                subprocess.run(['/usr/bin/logger', '-p', 'daemon.err', '-t', 'polkaswap-storage-guard', f'Safeguard failed: {error}'], check=True, timeout=10)
            except (OSError, subprocess.SubprocessError):
                pass
        return 2


if __name__ == '__main__':
    sys.exit(main())
