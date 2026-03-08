"""
Reorganize src/ by:
1. Creating subdirectory groups
2. Moving .rs files into them  
3. Updating lib.rs with #[path] attributes
4. Deleting pitch_analysis.rs.orig
"""
import os
import shutil
import re

SRC = r"E:\Code\HifiShifter\backend\src-tauri\src"
LIB = os.path.join(SRC, "lib.rs")

# Group definitions: subdir -> list of module names (without .rs)
GROUPS = {
    "audio": [
        "audio_utils",
        "mixdown",
        "rubberband",
        "time_stretch",
        "waveform",
        "waveform_disk_cache",
    ],
    "pitch": [
        "pitch_clip",
        "pitch_config",
        "pitch_config_tests",
        "pitch_editing",
        "pitch_progress",
        "clip_pitch_cache",
        "clip_rendering_state",
    ],
    "vocoder": [
        "world",
        "world_lock",
        "world_vocoder",
        "streaming_world",
        "nsf_hifigan_onnx",
        "nsf_hifigan_onnx_stub",
    ],
    "import": [
        "reaper_import",
        "reaper_parser",
        "vocalshifter_import",
        "vocalshifter_clipboard",
    ],
}

# Build reverse map: module_name -> subdir
MOD_TO_DIR = {}
for subdir, mods in GROUPS.items():
    for mod in mods:
        MOD_TO_DIR[mod] = subdir

# ── 1. Create directories ────────────────────────────────────────────────────
for subdir in GROUPS:
    os.makedirs(os.path.join(SRC, subdir), exist_ok=True)
    print(f"mkdir {subdir}/")

# ── 2. Move files ────────────────────────────────────────────────────────────
for mod, subdir in MOD_TO_DIR.items():
    src_path = os.path.join(SRC, f"{mod}.rs")
    dst_path = os.path.join(SRC, subdir, f"{mod}.rs")
    if os.path.exists(src_path):
        shutil.move(src_path, dst_path)
        print(f"  mv {mod}.rs → {subdir}/{mod}.rs")
    else:
        print(f"  SKIP (not found): {mod}.rs")

# ── 3. Delete old backup ─────────────────────────────────────────────────────
orig = os.path.join(SRC, "pitch_analysis.rs.orig")
if os.path.exists(orig):
    os.remove(orig)
    print(f"  rm pitch_analysis.rs.orig")

# ── 4. Update lib.rs ─────────────────────────────────────────────────────────
with open(LIB, encoding="utf-8") as f:
    lib = f.read()

# Strip BOM if present
lib = lib.lstrip("\ufeff")

# For each moved module, replace its mod declaration with a #[path] version.
# Handles both:
#   mod foo;
#   #[cfg(...)] mod foo;
# We insert the #[path] attribute just before the `mod foo;` token.
def patch_mod(text, mod_name, subdir):
    # Pattern: an optional leading attribute line, then the mod declaration
    # We'll match the exact `mod {name};` token and add path attr before it
    # Case 1: plain `mod foo;`
    # Case 2: `#[cfg(...)] mod foo;` or `#[cfg(...)]\nmod foo;`

    # Match standalone `mod {mod_name};` (not already having #[path])
    # and replace with `#[path = "subdir/mod_name.rs"] mod mod_name;`

    # Simple single-line: `mod foo;`
    pattern1 = rf'^(mod {re.escape(mod_name)};)$'
    new1 = f'#[path = "{subdir}/{mod_name}.rs"] mod {mod_name};'
    result = re.sub(pattern1, new1, text, flags=re.MULTILINE)
    if result != text:
        return result

    # After #[cfg(feature = "onnx")]\nmod foo;  → same line or two lines
    # Pattern: #[cfg(...)] on prev line, mod on next line
    pattern2 = rf'(#\[[^\]]+\])\n(mod {re.escape(mod_name)};)'
    new2 = rf'\1\n#[path = "{subdir}/{mod_name}.rs"]\n\2'
    result = re.sub(pattern2, new2, text)
    if result != text:
        return result

    # Inline: #[cfg(...)] mod foo;
    pattern3 = rf'(#\[[^\]]+\] mod {re.escape(mod_name)};)'
    new3 = f'#[path = "{subdir}/{mod_name}.rs"] \\1'
    result = re.sub(pattern3, new3, text)
    return result

for mod, subdir in MOD_TO_DIR.items():
    before = lib
    lib = patch_mod(lib, mod, subdir)
    changed = lib != before
    print(f"  lib.rs patch '{mod}': {'OK' if changed else 'ALREADY or SKIPPED'}")

with open(LIB, "w", encoding="utf-8", newline="\n") as f:
    f.write(lib)

print("\nDone. Run `cargo check` to verify.")
