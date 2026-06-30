// Samples the Earth day texture so the city view can show the real local
// terrain (land/ocean color and coastline) and place houses only on land.
// Loads the same /public image into an offscreen canvas once, then reads pixels.

let pixels: Uint8ClampedArray | null = null
let W = 0
let H = 0
let loaded = false
const listeners: (() => void)[] = []

if (typeof document !== 'undefined') {
  const img = new Image()
  img.src = '/earth-day.jpg'
  img.onload = () => {
    W = 1024
    H = 512
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.drawImage(img, 0, 0, W, H)
      try {
        pixels = ctx.getImageData(0, 0, W, H).data
        loaded = true
        listeners.forEach(l => l())
      } catch {
        /* sampling unavailable — callers fall back to "all land" */
      }
    }
  }
}

export function earthLoaded(): boolean {
  return loaded
}

export function onEarthLoaded(cb: () => void): void {
  if (loaded) cb()
  else listeners.push(cb)
}

// Raw RGB at a lat/long (equirectangular). Falls back to a neutral land color.
export function sampleEarth(lat: number, long: number): [number, number, number] {
  if (!pixels) return [46, 64, 44]
  let u = (long + 180) / 360
  let v = (90 - lat) / 180
  u = ((u % 1) + 1) % 1
  v = Math.min(0.999, Math.max(0, v))
  const px = Math.min(W - 1, Math.floor(u * W))
  const py = Math.min(H - 1, Math.floor(v * H))
  const i = (py * W + px) * 4
  return [pixels[i], pixels[i + 1], pixels[i + 2]]
}

// Heuristic land/ocean test for the NASA blue-marble palette: ocean pixels are
// blue-dominant and fairly dark, land is green/tan, ice is bright.
export function isWater(lat: number, long: number): boolean {
  const [r, g, b] = sampleEarth(lat, long)
  return b > r + 10 && b >= g - 5 && r < 75
}
