// DEPRECATED: This module is no longer needed after migrating to static WORLD linking.
// The mutex was previously used to serialize DLL loading operations when WORLD was
// dynamically loaded via libloading. With static linking (cc crate), all WORLD
// functions are linked at compile time, so this synchronization is unnecessary.
//
// This file can be safely deleted.

#![allow(dead_code)]

use std::sync::{Mutex, OnceLock};

pub fn world_dll_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}
