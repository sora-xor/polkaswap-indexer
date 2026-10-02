#!/usr/bin/env python3
"""Add or remove only this component's include in the existing Pi TLS server.

No changes happen without --apply. A failed configuration test or reload
restores the exact prior file and revalidates it. Run as administrator; the
existing configuration and nginx master already belong to that account.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import time

CONFIG = Path('/opt/homebrew/etc/nginx/servers/pi.soramitsu.io.conf')
APP_ROOT = Path('/Users/administrator/apps/polkaswap-chatgpt')
INCLUDE = '  include /Users/administrator/apps/polkaswap-chatgpt/nginx-location.inc;\n'
ANCHOR = '  location / {\n    return 404;\n  }\n'


def patched_config(original: str, remove: bool = False) -> str:
    """Preserve every existing route and refuse an ambiguous insertion point."""
    count = original.count(INCLUDE)
    if count > 1:
        raise ValueError('Duplicate component include; inspect the configuration.')
    if remove:
        inserted = INCLUDE + '\n'
        return original.replace(inserted if inserted in original else INCLUDE, '', 1)
    if count == 1:
        return original
    if original.count(ANCHOR) != 1:
        raise ValueError('Expected one unchanged Pi default-404 location.')
    if 'listen 443 ssl;' not in original or 'server_name pi.soramitsu.io;' not in original:
        raise ValueError('Expected the verified Pi HTTPS server configuration.')
    return original.replace(ANCHOR, INCLUDE + '\n' + ANCHOR, 1)


def replace_preserving_metadata(path: Path, content: bytes) -> None:
    """Atomically replace a regular config while retaining its owner and mode."""
    if path.is_symlink() or not path.is_file():
        raise ValueError('Configuration must be an existing regular file.')
    metadata = path.stat()
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, metadata.st_mode & 0o777)
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_include(path: Path, content: bytes) -> None:
    """Write a private include atomically without following a symlink."""
    if path.is_symlink():
        raise ValueError('Include must not be a symlink.')
    if path.exists():
        replace_preserving_metadata(path, content)
        return
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply_changes(config: Path, include: Path, candidate: bytes, desired_include: bytes | None, verify_reload) -> None:
    """Validate both files together and restore both on validation/reload failure."""
    original = config.read_bytes()
    if include.is_symlink():
        raise ValueError('Include must not be a symlink.')
    previous_include = include.read_bytes() if include.exists() else None
    try:
        if desired_include is not None and desired_include != previous_include:
            write_include(include, desired_include)
        if candidate != original:
            replace_preserving_metadata(config, candidate)
        verify_reload()
    except (subprocess.CalledProcessError, OSError):
        if config.read_bytes() != original:
            replace_preserving_metadata(config, original)
        if previous_include is None:
            if include.exists():
                include.unlink()
        elif include.read_bytes() != previous_include:
            write_include(include, previous_include)
        verify_reload()
        raise


def main() -> None:
    """Review by default; activate the route only after the service is tested."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--remove', action='store_true')
    args = parser.parse_args()
    original = CONFIG.read_bytes()
    candidate = patched_config(original.decode('utf-8'), args.remove).encode('utf-8')
    source = Path(__file__).with_name('nginx-location.inc')
    destination = APP_ROOT / 'nginx-location.inc'
    desired_include = None if args.remove else source.read_bytes()
    if destination.is_symlink():
        raise ValueError('Include must not be a symlink.')
    previous_include = destination.read_bytes() if destination.exists() else None
    include_changed = desired_include is not None and desired_include != previous_include
    if candidate == original and not include_changed:
        print('Component include is already in the requested state.')
        return
    if not args.apply:
        print('Proposed action: ' + ('remove' if args.remove else 'add') + ' isolated ChatGPT include.')
        print('Prior configuration SHA-256: ' + hashlib.sha256(original).hexdigest())
        print('Use --apply after reviewing nginx-location.inc and testing the loopback MCP endpoint.')
        return
    if os.getuid() != 501:
        raise ValueError('Run only as the existing administrator account (UID 501).')
    backups = APP_ROOT / 'state'
    backups.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = backups / ('nginx-prior-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.conf')
    # Exclusive creation preserves earlier rollback evidence even for quick retries.
    with backup.open('xb') as output:
        output.write(original)
    backup.chmod(0o600)
    if previous_include is not None:
        include_backup = backup.with_suffix('.inc')
        with include_backup.open('xb') as output:
            output.write(previous_include)
        include_backup.chmod(0o600)

    def verify_reload():
        subprocess.run(['/opt/homebrew/bin/nginx', '-t'], check=True)
        subprocess.run(['/opt/homebrew/bin/nginx', '-s', 'reload'], check=True)
    apply_changes(CONFIG, destination, candidate, desired_include, verify_reload)
    print('Updated only the isolated ChatGPT include; existing Pi routes preserved.')
    print('Prior configuration backup: ' + str(backup))


if __name__ == '__main__':
    main()
