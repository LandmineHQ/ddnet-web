// Minimal stand-in for <emscripten.h> so that the Emscripten-only code can be
// syntax-checked with a normal host compiler before running a real wasm build.
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

void emscripten_sleep(unsigned int ms);
void emscripten_force_exit(int status);

#ifdef __cplusplus
}
#endif

#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
// The JavaScript body is intentionally ignored, only the signature matters for
// syntax checking.
#define EM_JS(ret, name, params, ...) extern "C" ret name params;
