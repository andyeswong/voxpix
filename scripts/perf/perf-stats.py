# Estadísticas de una medida de perf.ps1: intervalos entre cuadros (rAF)
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
f = sorted(d["frames"])
if not f: print("sin muestras"); sys.exit()
q = lambda p: f[min(len(f) - 1, int(p * len(f)))]
slow = sum(1 for x in f if x > 18) / len(f) * 100
print(f"n={len(f)} med={q(0.5):.1f} p95={q(0.95):.1f} max={f[-1]:.1f} perdidos(>18ms)={slow:.1f}%  | {(d['hud'].splitlines()[1:2] or d['hud'].splitlines()[:1] or [''])[0] if d['hud'] else ''}")
