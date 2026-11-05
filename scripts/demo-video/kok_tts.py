# Narrates each scene line with Kokoro (open-source, runs locally) -> audio/NN.wav
import json, sys, soundfile as sf
from kokoro_onnx import Kokoro, EspeakConfig
d = sys.argv[1]
k = Kokoro(f"{d}/kokoro-v1.0.onnx", f"{d}/voices-v1.0.bin",
           espeak_config=EspeakConfig(lib_path="/opt/homebrew/lib/libespeak-ng.dylib",
                                      data_path="/opt/homebrew/share/espeak-ng-data"))
for i, line in enumerate(json.load(open(f"{d}/lines.json"))):
    audio, sr = k.create(line, voice="am_onyx", speed=0.95, lang="en-us")
    sf.write(f"{d}/audio/{i:02d}.wav", audio, sr)
    print("narrated", i)
