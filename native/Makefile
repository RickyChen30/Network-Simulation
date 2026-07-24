# GlobeNet TCP C core — build targets.
#
#   make test      native build of the core + harness, run the verification
#   make wasm      compile the core to WebAssembly for the browser (needs a
#                  wasm-capable toolchain — see notes below; not installed here)
#
# The core (tcp_core.c) is freestanding: no libc, no I/O, no malloc. So the SAME
# source compiles both to a native object (verified by tcp_test.c) and to a pure
# WASM module that drops in behind GlobeNet's TcpCtx seam.

CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra

.PHONY: test clean wasm

test: tcp_test
	./tcp_test

tcp_test: tcp_core.c tcp_test.c tcp_core.h
	$(CC) $(CFLAGS) tcp_core.c tcp_test.c -o tcp_test

# --- WebAssembly -----------------------------------------------------------
# The core imports one function (host_emit) and exports the tcp_* API. Two ways
# to build it, depending on the toolchain you install:
#
# 1) Freestanding clang (wasi-sdk or `brew install llvm`) — a lean, pure module:
#      clang --target=wasm32 -O2 -nostdlib -ffreestanding \
#        -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
#        -o tcp_core.wasm tcp_core.c
#    (--allow-undefined leaves host_emit as an import from the JS "env" module.)
#
# 2) Emscripten (emcc) — bundles a JS loader:
#      emcc tcp_core.c -O2 --no-entry \
#        -s EXPORTED_FUNCTIONS=@exports.txt \
#        -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
#        -o tcp_core.js
#
# The freestanding module is loaded by src/engine/tcp/wasm-loader.ts.
# This is the exact command used to build the checked-in public/tcp_core.wasm on
# this machine (Homebrew llvm@21 clang + lld@21 wasm-ld, installed via `brew
# install zig`, which pulls both in). Adjust the paths for your toolchain.
WASM_CLANG ?= /opt/homebrew/opt/llvm@21/bin/clang
WASM_LD_DIR ?= /opt/homebrew/opt/lld@21/bin
wasm: tcp_core.c tcp_core.h
	PATH="$(WASM_LD_DIR):$$PATH" $(WASM_CLANG) --target=wasm32 -O2 -nostdlib -ffreestanding \
		-Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
		-o tcp_core.wasm tcp_core.c
	cp tcp_core.wasm ../public/tcp_core.wasm
	@echo "built tcp_core.wasm and copied to public/ — enabled via WasmTcpStack in App.tsx"

clean:
	rm -f tcp_test tcp_core.wasm
