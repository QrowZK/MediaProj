// ═══════════════════════════════════════════════════════════════════════
// Auralis WASAPI exclusive-mode render backend (Windows, N-API).
//
// JS contract (see ../index.js):
//   listDevices() -> [{ id, name, isDefault }]
//   open({ deviceId, sampleRate, channels, bits, bufferMs })
//        -> { handle, bufferFrames, validBits, containerBits, rate }
//   write(handle, buffer)   // interleaved int32 LE, LEFT-JUSTIFIED samples
//   queued(handle)          // frames waiting in the ring
//   position(handle)        // frames handed to the device since start()
//   start(handle) / stop(handle) / clear(handle) / close(handle)
//
// The render thread is event-driven (AUDCLNT_STREAMFLAGS_EVENTCALLBACK) and
// converts the left-justified int32 ring content to the negotiated wire
// format (32/24-in-32, packed 24, or 16). Underruns render silence.
// ═══════════════════════════════════════════════════════════════════════

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

std::string WideToUtf8(const wchar_t* w) {
  if (!w) return "";
  int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string out(len > 0 ? len - 1 : 0, '\0');
  if (len > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
  return out;
}

std::wstring Utf8ToWide(const std::string& s) {
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring out(len > 0 ? len - 1 : 0, L'\0');
  if (len > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), len);
  return out;
}

struct ComInit {
  ComInit() { CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
  ~ComInit() { CoUninitialize(); }
};

#define THROW_IF_FAILED(env, hr, what)                                        \
  if (FAILED(hr)) {                                                           \
    char buf[256];                                                            \
    snprintf(buf, sizeof(buf), "%s failed (hr=0x%08lx)", what, (long)(hr));   \
    Napi::Error::New(env, buf).ThrowAsJavaScriptException();                  \
    return env.Undefined();                                                   \
  }

struct Stream {
  IMMDevice* device = nullptr;
  IAudioClient* client = nullptr;
  IAudioRenderClient* render = nullptr;
  HANDLE event = nullptr;

  UINT32 bufferFrames = 0;
  int channels = 2;
  int validBits = 32;      // meaningful bits per sample
  int containerBits = 32;  // wire container: 32, 24 (packed), or 16
  int sampleRate = 44100;

  // ring buffer of LEFT-JUSTIFIED int32 samples (interleaved)
  std::vector<int32_t> ring;
  size_t ringHead = 0;  // read index (samples)
  size_t ringTail = 0;  // write index (samples)
  size_t ringCount = 0; // samples stored
  std::mutex ringMutex;

  std::atomic<uint64_t> framesRendered{0};
  std::atomic<bool> running{false};
  std::atomic<bool> quit{false};
  std::thread thread;

  ~Stream() { Teardown(); }

  void Teardown() {
    quit = true;
    running = false;
    if (event) SetEvent(event);
    if (thread.joinable()) thread.join();
    if (client) client->Stop();
    if (render) { render->Release(); render = nullptr; }
    if (client) { client->Release(); client = nullptr; }
    if (device) { device->Release(); device = nullptr; }
    if (event) { CloseHandle(event); event = nullptr; }
  }

  size_t RingCapacity() const { return ring.size(); }

  size_t PopInto(int32_t* dst, size_t samples) {
    std::lock_guard<std::mutex> lock(ringMutex);
    size_t n = samples < ringCount ? samples : ringCount;
    for (size_t i = 0; i < n; i++) {
      dst[i] = ring[ringHead];
      ringHead = (ringHead + 1) % ring.size();
    }
    ringCount -= n;
    return n;
  }

  void RenderLoop() {
    ComInit com;
    DWORD taskIndex = 0;
    HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    std::vector<int32_t> staging;
    while (!quit) {
      DWORD wait = WaitForSingleObject(event, 2000);
      if (quit) break;
      if (wait != WAIT_OBJECT_0 || !running) continue;

      BYTE* data = nullptr;
      if (FAILED(render->GetBuffer(bufferFrames, &data))) continue;

      const size_t samples = (size_t)bufferFrames * channels;
      staging.resize(samples);
      size_t got = PopInto(staging.data(), samples);
      for (size_t i = got; i < samples; i++) staging[i] = 0; // underrun → silence

      if (containerBits == 32) {
        memcpy(data, staging.data(), samples * 4);
      } else if (containerBits == 24) {
        BYTE* p = data;
        for (size_t i = 0; i < samples; i++) {
          uint32_t v = (uint32_t)staging[i];
          *p++ = (BYTE)(v >> 8);
          *p++ = (BYTE)(v >> 16);
          *p++ = (BYTE)(v >> 24);
        }
      } else { // 16
        int16_t* p = (int16_t*)data;
        for (size_t i = 0; i < samples; i++) p[i] = (int16_t)(staging[i] >> 16);
      }
      render->ReleaseBuffer(bufferFrames, 0);
      framesRendered += bufferFrames;
    }
    if (task) AvRevertMmThreadCharacteristics(task);
  }
};

std::map<int, std::shared_ptr<Stream>> g_streams;
std::mutex g_streamsMutex;
int g_nextHandle = 1;

std::shared_ptr<Stream> GetStream(int handle) {
  std::lock_guard<std::mutex> lock(g_streamsMutex);
  auto it = g_streams.find(handle);
  return it == g_streams.end() ? nullptr : it->second;
}

WAVEFORMATEXTENSIBLE MakeFormat(int rate, int channels, int validBits, int containerBits) {
  WAVEFORMATEXTENSIBLE fmt = {};
  fmt.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  fmt.Format.nChannels = (WORD)channels;
  fmt.Format.nSamplesPerSec = rate;
  fmt.Format.wBitsPerSample = (WORD)containerBits;
  fmt.Format.nBlockAlign = (WORD)(channels * containerBits / 8);
  fmt.Format.nAvgBytesPerSec = rate * fmt.Format.nBlockAlign;
  fmt.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  fmt.Samples.wValidBitsPerSample = (WORD)validBits;
  fmt.dwChannelMask = channels == 1 ? SPEAKER_FRONT_CENTER
                                    : (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT);
  fmt.SubFormat = KSDATAFORMAT_SUBTYPE_PCM;
  return fmt;
}

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComInit com;
  IMMDeviceEnumerator* devEnum = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&devEnum);
  THROW_IF_FAILED(env, hr, "MMDeviceEnumerator");

  std::string defaultId;
  IMMDevice* def = nullptr;
  if (SUCCEEDED(devEnum->GetDefaultAudioEndpoint(eRender, eConsole, &def))) {
    LPWSTR id = nullptr;
    if (SUCCEEDED(def->GetId(&id))) { defaultId = WideToUtf8(id); CoTaskMemFree(id); }
    def->Release();
  }

  IMMDeviceCollection* coll = nullptr;
  hr = devEnum->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &coll);
  devEnum->Release();
  THROW_IF_FAILED(env, hr, "EnumAudioEndpoints");

  UINT count = 0;
  coll->GetCount(&count);
  Napi::Array out = Napi::Array::New(env, count);
  for (UINT i = 0; i < count; i++) {
    IMMDevice* dev = nullptr;
    if (FAILED(coll->Item(i, &dev))) continue;
    LPWSTR wid = nullptr;
    dev->GetId(&wid);
    std::string id = WideToUtf8(wid);
    CoTaskMemFree(wid);

    std::string name = id;
    IPropertyStore* props = nullptr;
    if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT v;
      PropVariantInit(&v);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) {
        name = WideToUtf8(v.pwszVal);
      }
      PropVariantClear(&v);
      props->Release();
    }
    dev->Release();

    Napi::Object o = Napi::Object::New(env);
    o.Set("id", id);
    o.Set("name", name);
    o.Set("isDefault", id == defaultId);
    out.Set(i, o);
  }
  coll->Release();
  return out;
}

Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "open(options) expected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object opts = info[0].As<Napi::Object>();
  std::string deviceId = opts.Has("deviceId") && opts.Get("deviceId").IsString()
                             ? opts.Get("deviceId").As<Napi::String>().Utf8Value() : "";
  int rate = opts.Get("sampleRate").As<Napi::Number>().Int32Value();
  int channels = opts.Get("channels").As<Napi::Number>().Int32Value();
  int wantBits = opts.Has("bits") ? opts.Get("bits").As<Napi::Number>().Int32Value() : 32;
  int bufferMs = opts.Has("bufferMs") ? opts.Get("bufferMs").As<Napi::Number>().Int32Value() : 20;

  ComInit com;
  IMMDeviceEnumerator* devEnum = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&devEnum);
  THROW_IF_FAILED(env, hr, "MMDeviceEnumerator");

  auto stream = std::make_shared<Stream>();
  if (deviceId.empty()) {
    hr = devEnum->GetDefaultAudioEndpoint(eRender, eConsole, &stream->device);
  } else {
    hr = devEnum->GetDevice(Utf8ToWide(deviceId).c_str(), &stream->device);
  }
  devEnum->Release();
  THROW_IF_FAILED(env, hr, "GetDevice");

  hr = stream->device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                (void**)&stream->client);
  THROW_IF_FAILED(env, hr, "IAudioClient Activate");

  // Negotiate a format the device supports in exclusive mode, best first.
  struct Cand { int valid; int container; };
  std::vector<Cand> candidates;
  if (wantBits >= 32) candidates = {{32, 32}, {24, 32}, {24, 24}, {16, 16}};
  else if (wantBits == 24) candidates = {{24, 32}, {24, 24}, {32, 32}, {16, 16}};
  else candidates = {{16, 16}, {24, 32}, {24, 24}, {32, 32}};

  WAVEFORMATEXTENSIBLE chosen = {};
  bool found = false;
  for (const auto& c : candidates) {
    WAVEFORMATEXTENSIBLE f = MakeFormat(rate, channels, c.valid, c.container);
    if (stream->client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                          (WAVEFORMATEX*)&f, nullptr) == S_OK) {
      chosen = f;
      stream->validBits = c.valid;
      stream->containerBits = c.container;
      found = true;
      break;
    }
  }
  if (!found) {
    Napi::Error::New(env, "Device does not support " + std::to_string(rate) +
                              " Hz PCM in exclusive mode")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  REFERENCE_TIME period = (REFERENCE_TIME)bufferMs * 10000; // ms → 100ns units
  hr = stream->client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                  period, period, (WAVEFORMATEX*)&chosen, nullptr);
  if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
    // classic exclusive-mode dance: re-init with the aligned buffer size
    UINT32 frames = 0;
    stream->client->GetBufferSize(&frames);
    stream->client->Release();
    stream->client = nullptr;
    period = (REFERENCE_TIME)((10000.0 * 1000 / rate * frames) + 0.5);
    hr = stream->device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                  (void**)&stream->client);
    THROW_IF_FAILED(env, hr, "IAudioClient re-Activate");
    hr = stream->client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                    period, period, (WAVEFORMATEX*)&chosen, nullptr);
  }
  THROW_IF_FAILED(env, hr, "IAudioClient Initialize (exclusive)");

  stream->event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = stream->client->SetEventHandle(stream->event);
  THROW_IF_FAILED(env, hr, "SetEventHandle");
  hr = stream->client->GetBufferSize(&stream->bufferFrames);
  THROW_IF_FAILED(env, hr, "GetBufferSize");
  hr = stream->client->GetService(__uuidof(IAudioRenderClient), (void**)&stream->render);
  THROW_IF_FAILED(env, hr, "IAudioRenderClient");

  stream->channels = channels;
  stream->sampleRate = rate;
  // ring: ~2 seconds of left-justified int32 samples
  stream->ring.assign((size_t)rate * channels * 2, 0);

  stream->thread = std::thread([s = stream.get()] { s->RenderLoop(); });

  int handle;
  {
    std::lock_guard<std::mutex> lock(g_streamsMutex);
    handle = g_nextHandle++;
    g_streams[handle] = stream;
  }

  Napi::Object out = Napi::Object::New(env);
  out.Set("handle", handle);
  out.Set("bufferFrames", (double)stream->bufferFrames);
  out.Set("validBits", stream->validBits);
  out.Set("containerBits", stream->containerBits);
  out.Set("rate", rate);
  return out;
}

Napi::Value Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto s = GetStream(info[0].As<Napi::Number>().Int32Value());
  if (!s || !info[1].IsBuffer()) return Napi::Number::New(env, 0);
  Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
  size_t samples = buf.Length() / 4; // bytes → whole int32 samples
  {
    std::lock_guard<std::mutex> lock(s->ringMutex);
    const int32_t* src = (const int32_t*)buf.Data();
    size_t space = s->ring.size() - s->ringCount;
    size_t n = samples < space ? samples : space; // overflow: drop tail
    for (size_t i = 0; i < n; i++) {
      s->ring[s->ringTail] = src[i];
      s->ringTail = (s->ringTail + 1) % s->ring.size();
    }
    s->ringCount += n;
  }
  return Napi::Number::New(env, (double)(s->ringCount / s->channels));
}

Napi::Value Queued(const Napi::CallbackInfo& info) {
  auto s = GetStream(info[0].As<Napi::Number>().Int32Value());
  if (!s) return Napi::Number::New(info.Env(), 0);
  std::lock_guard<std::mutex> lock(s->ringMutex);
  return Napi::Number::New(info.Env(), (double)(s->ringCount / s->channels));
}

Napi::Value Position(const Napi::CallbackInfo& info) {
  auto s = GetStream(info[0].As<Napi::Number>().Int32Value());
  return Napi::Number::New(info.Env(), s ? (double)s->framesRendered.load() : 0);
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  auto s = GetStream(info[0].As<Napi::Number>().Int32Value());
  if (s && s->client && !s->running) {
    s->running = true;
    s->client->Start();
  }
  return info.Env().Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  auto s = GetStream(info[0].As<Napi::Number>().Int32Value());
  if (s && s->client && s->running) {
    s->running = false;
    s->client->Stop();
  }
  return info.Env().Undefined();
}

Napi::Value Clear(const Napi::CallbackInfo& info) {
  auto s = GetStream(info[0].As<Napi::Number>().Int32Value());
  if (s) {
    std::lock_guard<std::mutex> lock(s->ringMutex);
    s->ringHead = s->ringTail = s->ringCount = 0;
  }
  return info.Env().Undefined();
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  int handle = info[0].As<Napi::Number>().Int32Value();
  std::shared_ptr<Stream> s;
  {
    std::lock_guard<std::mutex> lock(g_streamsMutex);
    auto it = g_streams.find(handle);
    if (it != g_streams.end()) { s = it->second; g_streams.erase(it); }
  }
  if (s) s->Teardown();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("open", Napi::Function::New(env, Open));
  exports.Set("write", Napi::Function::New(env, Write));
  exports.Set("queued", Napi::Function::New(env, Queued));
  exports.Set("position", Napi::Function::New(env, Position));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("clear", Napi::Function::New(env, Clear));
  exports.Set("close", Napi::Function::New(env, Close));
  return exports;
}

NODE_API_MODULE(wasapi_exclusive, Init)

}  // namespace
