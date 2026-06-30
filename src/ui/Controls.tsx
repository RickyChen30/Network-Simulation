// Keyboard controls legend. Key handling itself lives in App.tsx.

interface Binding {
  key: string
  label: string
}

const BINDINGS: Binding[] = [
  { key: 'SPACE', label: 'Pause / Resume' },
  { key: 'R', label: 'Reset simulation' },
  { key: 'A', label: 'Adaptive routing' },
  { key: 'D', label: 'DDoS burst' },
  { key: 'F', label: 'Toggle firewall' },
  { key: 'ESC', label: 'Back to globe' },
]

export function Controls() {
  return (
    <div className="absolute bottom-4 left-4 bg-slate-950/70 backdrop-blur-md border border-white/10 rounded-xl p-3.5 shadow-2xl pointer-events-none select-none">
      <p className="text-[11px] text-slate-400 uppercase tracking-[0.2em] mb-2.5">Controls</p>
      <div className="space-y-1.5">
        {BINDINGS.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-2.5">
            <kbd className="text-[11px] bg-white/10 border border-white/20 rounded px-1.5 py-0.5 font-mono text-white min-w-[3.2rem] text-center">
              {key}
            </kbd>
            <span className="text-xs text-slate-400">{label}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-slate-500 mt-2.5 pt-2.5 border-t border-white/5">
        Drag to orbit · scroll to zoom
        <br />Click a city to fly in
      </p>
    </div>
  )
}
