// Standalone probe for the browser WebSocket transport technique used by the
// DDNet web client (see src/engine/shared/websockets_emscripten.cpp).
// Build:  emcc probe.cpp -o probe.js -sASYNCIFY=1 -sALLOW_BLOCKING_ON_MAIN_THREAD=1 -sEXIT_RUNTIME=1
// Run:    node probe.js "ws://127.0.0.1:8390/udp/127.0.0.1:9001"
#include <emscripten.h>

#include <cstdio>
#include <cstring>

// clang-format off
EM_JS(int, p_open, (const char *pUrl), {
	var g = Module['DDWS'] || (Module['DDWS'] = { slots: [], free: [] });
	var idx = g.free.length > 0 ? g.free.pop() : g.slots.length;
	var rec = { ws: null, inq: [], outq: [], closed: false, opened: false };
	g.slots[idx] = rec;
	try {
		var ws = new WebSocket(UTF8ToString(pUrl));
		ws.binaryType = 'arraybuffer';
		rec.ws = ws;
		ws.onopen = function() {
			rec.opened = true;
			while (rec.outq.length > 0) {
				try { ws.send(rec.outq.shift()); } catch (e) { rec.closed = true; return; }
			}
		};
		ws.onmessage = function(e) { rec.inq.push(new Uint8Array(e.data)); };
		ws.onclose = function() { rec.closed = true; };
		ws.onerror = function() { rec.closed = true; };
	} catch (e) {
		rec.closed = true;
		return -1;
	}
	return idx;
});

EM_JS(int, p_send, (int slot, const void *pData, int size), {
	var g = Module['DDWS'];
	if (!g || !g.slots[slot]) return -1;
	var rec = g.slots[slot];
	if (rec.closed) return -1;
	var copy = new Uint8Array(HEAPU8.subarray(pData, pData + size));
	if (rec.opened && rec.ws && rec.ws.readyState === 1) {
		try { rec.ws.send(copy); } catch (e) { rec.closed = true; return -1; }
	} else {
		rec.outq.push(copy);
	}
	return size;
});

EM_JS(int, p_poll, (int slot, void *pData, int maxSize), {
	var g = Module['DDWS'];
	if (!g || !g.slots[slot]) return -1;
	var rec = g.slots[slot];
	if (rec.inq.length === 0) return rec.closed ? -1 : 0;
	var frame = rec.inq.shift();
	var n = Math.min(frame.length, maxSize);
	HEAPU8.set(frame.subarray(0, n), pData);
	return n;
});
// clang-format on

int main(int argc, char **argv)
{
	const char *pUrl = argc > 1 ? argv[1] : "ws://127.0.0.1:8390/udp/127.0.0.1:9001";
	printf("[probe] opening %s\n", pUrl);
	const int Slot = p_open(pUrl);
	if(Slot < 0)
	{
		printf("[probe] open failed\n");
		return 2;
	}
	const char *pMsg = "probe-hello";
	for(int i = 0; i < 100; i++)
	{
		if(p_send(Slot, pMsg, (int)strlen(pMsg)) > 0 && i == 0)
		{
			printf("[probe] sent %d bytes\n", (int)strlen(pMsg));
		}
		unsigned char aBuf[2048];
		const int Bytes = p_poll(Slot, aBuf, (int)sizeof(aBuf));
		if(Bytes > 0)
		{
			printf("[probe] RECV %d bytes: %.*s\n", Bytes, Bytes, (const char *)aBuf);
			return 0;
		}
		emscripten_sleep(100);
	}
	printf("[probe] TIMEOUT\n");
	return 1;
}
