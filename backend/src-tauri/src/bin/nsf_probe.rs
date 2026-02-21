fn main() {
    // A tiny dev probe to diagnose NSF-HiFiGAN ONNX loading issues without launching the full app.
    // Usage (PowerShell):
    //   $env:HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR = "E:\\Code\\HifiShifter\\pc_nsf_hifigan_44.1k_hop512_128bin_2025.02"
    //   cargo run --bin nsf_probe

    let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS")
        .ok()
        .as_deref()
        == Some("1");

    match backend_lib::nsf_hifigan_onnx_probe() {
        Ok(msg) => {
            println!("{msg}");
        }
        Err(e) => {
            if debug {
                eprintln!("nsf_probe: failed: {e}");
            } else {
                eprintln!("nsf_probe: failed (set HIFISHIFTER_DEBUG_COMMANDS=1 for details)");
                eprintln!("{e}");
            }
            std::process::exit(1);
        }
    }
}
