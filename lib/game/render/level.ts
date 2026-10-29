import * as THREE from 'three'
import type { BaseFace, Face, RoundDTO } from '@/lib/shared/game'
import { GROUND_Y } from './city'
import { drawFace, faceTexture } from './faces'
import { type PBRSet, makeConcrete, makeGrating, makeHazardStripes, makeSteel } from './textures'

export const FIRST_GATE_Z = -11
export const GATE_SPACING = 8.5
export const WALK_HALF = 0.62
export const GATE_HALF = 2.3
export const EYE_HEIGHT = 1.65
export const START_Z = 2.6
const START_SLAB = { front: -3, back: 8, half: 5 }

export class LevelMaterials {
  steel: THREE.MeshStandardMaterial
  darkSteel: THREE.MeshStandardMaterial
  grating: THREE.MeshStandardMaterial
  concrete: THREE.MeshStandardMaterial
  hazard: THREE.MeshStandardMaterial
  doorSteel: THREE.MeshStandardMaterial
  bulb: THREE.MeshStandardMaterial
  rivet: THREE.MeshStandardMaterial
  private sets: PBRSet[] = []

  constructor(textureSize: number) {
    const steel = makeSteel(textureSize, 7)
    const door = makeSteel(textureSize, 23)
    const grating = makeGrating(textureSize)
    const concrete = makeConcrete(textureSize)
    this.sets.push(steel, door, grating, concrete)

    const tiled = (set: PBRSet, repeat: number) => {
      for (const tex of [set.map, set.normalMap, set.roughnessMap]) tex.repeat.set(repeat, repeat)
      return set
    }

    this.steel = new THREE.MeshStandardMaterial({ ...tiled(steel, 1), metalness: 0.85, normalScale: new THREE.Vector2(0.8, 0.8) })
    this.darkSteel = new THREE.MeshStandardMaterial({ ...steel, color: 0x7a7f88, metalness: 0.9 })
    this.doorSteel = new THREE.MeshStandardMaterial({ ...door, metalness: 0.75, color: 0x9aa0aa })
    this.grating = new THREE.MeshStandardMaterial({
      ...grating,
      metalness: 0.8,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    })
    this.concrete = new THREE.MeshStandardMaterial({ ...concrete, metalness: 0 })
    this.hazard = new THREE.MeshStandardMaterial({ map: makeHazardStripes(), roughness: 0.6, metalness: 0.2 })
    this.bulb = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffb36b, emissiveIntensity: 6 })
    this.rivet = new THREE.MeshStandardMaterial({ color: 0x55585e, metalness: 0.9, roughness: 0.4 })
  }
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, uvScale = 1) {
  const geo = new THREE.BoxGeometry(w, h, d)
  if (uvScale !== 1) {
    const uv = geo.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(w, d) * uvScale, uv.getY(i) * h * uvScale)
  }
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(x, y, z)
  return mesh
}

function gratingFloor(mat: THREE.Material, width: number, zFrom: number, zTo: number, x = 0) {
  const length = zFrom - zTo
  const geo = new THREE.PlaneGeometry(width, length)
  const uv = geo.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * width * 1.4, uv.getY(i) * length * 1.4)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(x, 0, (zFrom + zTo) / 2)
  return mesh
}

/** I-beam along Z. */
function iBeamZ(mats: LevelMaterials, x: number, zFrom: number, zTo: number, y = -0.03, rivets?: number[]) {
  const group = new THREE.Group()
  const len = zFrom - zTo
  const cz = (zFrom + zTo) / 2
  group.add(box(0.2, 0.025, len, mats.steel, x, y - 0.0125, cz, 0.8))
  group.add(box(0.025, 0.3, len, mats.steel, x, y - 0.175, cz, 0.8))
  group.add(box(0.2, 0.025, len, mats.steel, x, y - 0.3375, cz, 0.8))
  if (rivets) {
    for (let z = zFrom - 0.12; z > zTo; z -= 0.22) rivets.push(x - 0.075, y, z, x + 0.075, y, z)
  }
  return group
}

function iBeamX(mats: LevelMaterials, z: number, xFrom: number, xTo: number, y = -0.03) {
  const group = new THREE.Group()
  const len = xTo - xFrom
  const cx = (xFrom + xTo) / 2
  group.add(box(len, 0.025, 0.2, mats.steel, cx, y - 0.0125, z, 0.8))
  group.add(box(len, 0.3, 0.025, mats.steel, cx, y - 0.175, z, 0.8))
  group.add(box(len, 0.025, 0.2, mats.steel, cx, y - 0.3375, z, 0.8))
  return group
}

export interface DoorObject {
  slot: number
  face: Face
  x: number
  fromX: number
  root: THREE.Group
  panelPivot: THREE.Group
  trapPivot: THREE.Group
  faceMat: THREE.MeshStandardMaterial
  lampMat: THREE.MeshStandardMaterial
  openT: number
  trapT: number
  rattle: number
}

export interface Gate {
  index: number
  z: number
  slotWidth: number
  doors: DoorObject[]
  swapT: number
  swapping: boolean
}

export class Sign {
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  private canvas: HTMLCanvasElement
  private texture: THREE.CanvasTexture
  intensity = 0
  target = 0
  flicker = 0

  constructor(width: number, height: number, private tint: string | null) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 1024
    this.canvas.height = Math.round((1024 * height) / width)
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 8
    this.material = new THREE.MeshStandardMaterial({
      color: 0x050505,
      roughness: 0.25,
      metalness: 0.1,
      emissive: 0xffffff,
      emissiveMap: this.texture,
      emissiveIntensity: 0,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material)
    this.clear()
  }

  clear() {
    const ctx = this.canvas.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.texture.needsUpdate = true
  }

  show(sequence: Face[]) {
    const ctx = this.canvas.getContext('2d')!
    const { width, height } = this.canvas
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    // LED dot-matrix backdrop.
    ctx.fillStyle = this.tint ? '#1a0505' : '#0b0d10'
    for (let y = 6; y < height; y += 12) for (let x = 6; x < width; x += 12) ctx.fillRect(x, y, 3, 3)

    const rows = sequence.length > 6 ? 2 : 1
    const perRow = Math.ceil(sequence.length / rows)
    const cellW = width / perRow
    const cellH = height / rows
    const r = Math.min(cellW, cellH) * 0.33
    sequence.forEach((face, i) => {
      const row = Math.floor(i / perRow)
      const col = i % perRow
      const rowCount = row === rows - 1 ? sequence.length - perRow * (rows - 1) : perRow
      const offset = (perRow - rowCount) * cellW * 0.5
      const cx = offset + cellW * (col + 0.5)
      const cy = cellH * (row + 0.45)
      drawFace(ctx, face, cx, cy, r)
      ctx.fillStyle = this.tint ?? '#8a93a3'
      ctx.font = `600 ${Math.round(r * 0.42)}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.fillText(String(i + 1), cx, cy + r * 1.55)
    })
    if (this.tint) {
      ctx.globalCompositeOperation = 'multiply'
      ctx.fillStyle = this.tint
      ctx.fillRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'source-over'
    }
    this.texture.needsUpdate = true
  }

  update(dt: number, time: number) {
    const k = 1 - Math.exp(-dt * 18)
    this.intensity += (this.target - this.intensity) * k
    let value = this.intensity
    if (this.flicker > 0) {
      const n = Math.sin(time * 53.1) * Math.sin(time * 17.3 + 1.3)
      value *= n > 0.25 - this.flicker * 0.6 ? 1 : 0.05
    }
    this.material.emissiveIntensity = value * 2.6
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}

export class Level {
  group = new THREE.Group()
  gates: Gate[] = []
  sign: Sign
  fakeSign: Sign | null = null
  lamps: { position: THREE.Vector3; phase: number }[] = []
  bulbs: THREE.Mesh[] = []
  endZ: number
  endPlatformZ: number
  private disposables: { dispose(): void }[] = []

  constructor(
    private mats: LevelMaterials,
    round: Pick<RoundDTO, 'steps' | 'modifiers'>,
    withRivets: boolean,
  ) {
    const rivets: number[] = []
    const gateCount = round.steps.length
    const lastGateZ = FIRST_GATE_Z - (gateCount - 1) * GATE_SPACING
    this.endPlatformZ = lastGateZ - 9
    this.endZ = this.endPlatformZ

    this.buildTower(0, (START_SLAB.front + START_SLAB.back) / 2, START_SLAB.back - START_SLAB.front)
    this.buildTower(0, this.endPlatformZ - 3, 11)

    // Walkway segments between platforms and gates.
    let z = START_SLAB.front
    round.steps.forEach((step, i) => {
      const gz = FIRST_GATE_Z - i * GATE_SPACING
      this.buildWalkway(z, gz + 2.0, rivets)
      this.gates.push(this.buildGate(i, gz, step.faces, step.preSwap, rivets))
      z = gz - 1.6
    })
    this.buildWalkway(z, this.endPlatformZ + 2.5, rivets)

    // Main sign over the start of the walkway.
    this.sign = new Sign(5.2, 1.9, null)
    this.sign.mesh.position.set(0, 3.05, -2.4)
    this.group.add(this.sign.mesh)
    this.group.add(box(5.5, 0.12, 0.25, mats.steel, 0, 4.06, -2.45))
    this.group.add(box(5.5, 0.12, 0.25, mats.steel, 0, 2.04, -2.45))
    this.group.add(box(0.18, 4.2, 0.18, mats.steel, -2.75, 2.1, -2.5))
    this.group.add(box(0.18, 4.2, 0.18, mats.steel, 2.75, 2.1, -2.5))
    this.disposables.push(this.sign)

    if (round.modifiers.fakeSign) {
      this.fakeSign = new Sign(2.8, 1.1, '#ff5a3c')
      this.fakeSign.mesh.position.set(3.6, 2.5, -1.2)
      this.fakeSign.mesh.rotation.y = -0.55
      this.fakeSign.show(round.modifiers.fakeSign as BaseFace[])
      this.group.add(this.fakeSign.mesh)
      const post = box(0.12, 2.5, 0.12, mats.steel, 3.6, 0.95, -1.2)
      this.group.add(post)
      this.disposables.push(this.fakeSign)
    }

    this.addLamp(-4.4, 2.5, 2)
    this.addLamp(4.4, 2.5, -2)
    this.addLamp(-3.5, 2.5, this.endPlatformZ + 1)

    if (withRivets && rivets.length) {
      const geo = new THREE.SphereGeometry(0.016, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2)
      const mesh = new THREE.InstancedMesh(geo, mats.rivet, rivets.length / 3)
      const m = new THREE.Matrix4()
      for (let i = 0; i < rivets.length / 3; i++) {
        m.makeTranslation(rivets[i * 3], rivets[i * 3 + 1], rivets[i * 3 + 2])
        mesh.setMatrixAt(i, m)
      }
      mesh.instanceMatrix.needsUpdate = true
      this.group.add(mesh)
    }
  }

  private buildTower(x: number, z: number, size: number) {
    const m = this.mats
    const height = -GROUND_Y
    this.group.add(box(size, 0.35, size, m.concrete, x, -0.175, z, 0.35))
    const core = box(size - 1.2, height, size - 1.2, m.concrete, x, -height / 2 - 0.35, z, 0.05)
    this.group.add(core)
    // Exposed columns and floor slabs of the unfinished top floors.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.group.add(box(0.5, 12, 0.5, m.concrete, x + sx * (size / 2 - 0.35), -6.35, z + sz * (size / 2 - 0.35), 0.4))
      }
    }
    for (let i = 1; i <= 3; i++) this.group.add(box(size - 0.2, 0.3, size - 0.2, m.concrete, x, -i * 3.8, z, 0.35))
    // Rebar sticking out of the roof edge.
    for (let i = 0; i < 9; i++) {
      const rebar = box(0.025, 0.6 + (i % 3) * 0.3, 0.025, m.darkSteel, x - size / 2 + 0.3 + i * (size / 9), 0.3, z + size / 2 - 0.2)
      rebar.rotation.z = ((i % 4) - 1.5) * 0.08
      this.group.add(rebar)
    }
  }

  private buildWalkway(zFrom: number, zTo: number, rivets: number[]) {
    if (zFrom - zTo < 0.05) return
    const m = this.mats
    this.group.add(gratingFloor(m.grating, WALK_HALF * 2, zFrom, zTo))
    this.group.add(iBeamZ(m, -WALK_HALF + 0.05, zFrom, zTo, -0.02, rivets))
    this.group.add(iBeamZ(m, WALK_HALF - 0.05, zFrom, zTo, -0.02, rivets))
    for (let z = zFrom - 0.8; z > zTo; z -= 1.6) this.group.add(box(WALK_HALF * 2, 0.08, 0.08, m.darkSteel, 0, -0.2, z))
    // Diagonal truss under the walkway.
    const len = zFrom - zTo
    const truss = box(0.06, 0.06, len, m.darkSteel, 0, -0.9, (zFrom + zTo) / 2)
    this.group.add(truss)
    for (let z = zFrom - 0.4; z > zTo; z -= 2.4) {
      for (const s of [-1, 1]) {
        const diag = box(0.05, 1.0, 0.05, m.darkSteel, s * WALK_HALF * 0.5, -0.55, z)
        diag.rotation.z = s * 0.55
        this.group.add(diag)
      }
    }
  }

  private buildGate(index: number, gz: number, faces: Face[], preSwap: Face[] | null, rivets: number[]): Gate {
    const m = this.mats
    const n = faces.length
    const slotWidth = (GATE_HALF * 2) / n
    const doorWidth = slotWidth - 0.2
    // Approach strip and exit deck around the trap panels.
    this.group.add(gratingFloor(m.grating, GATE_HALF * 2, gz + 2.0, gz + 1.4))
    this.group.add(gratingFloor(m.grating, GATE_HALF * 2, gz + 0.05, gz - 1.6))
    this.group.add(iBeamX(m, gz + 2.0, -GATE_HALF, GATE_HALF))
    this.group.add(iBeamX(m, gz - 1.6, -GATE_HALF, GATE_HALF))
    this.group.add(iBeamZ(m, -GATE_HALF + 0.1, gz + 2.0, gz - 1.6, -0.02, rivets))
    this.group.add(iBeamZ(m, GATE_HALF - 0.1, gz + 2.0, gz - 1.6, -0.02, rivets))
    // Header beam spanning all doors.
    this.group.add(box(GATE_HALF * 2 + 0.3, 0.55, 0.2, m.steel, 0, 2.85, gz, 0.6))
    this.group.add(box(GATE_HALF * 2 + 0.3, 0.12, 0.22, m.hazard, 0, 2.52, gz))

    const doors: DoorObject[] = []
    faces.forEach((face, slot) => {
      const x = -GATE_HALF + slotWidth * (slot + 0.5)
      const fromSlot = preSwap ? preSwap.indexOf(face) : slot
      const fromX = -GATE_HALF + slotWidth * (fromSlot + 0.5)
      const root = new THREE.Group()
      root.position.set(fromX, 0, gz)

      root.add(box(0.1, 2.5, 0.14, m.steel, -slotWidth / 2 + 0.05, 1.25, 0))
      root.add(box(0.1, 2.5, 0.14, m.steel, slotWidth / 2 - 0.05, 1.25, 0))

      const panelPivot = new THREE.Group()
      panelPivot.position.set(-doorWidth / 2, 0, 0)
      const panel = box(doorWidth, 2.2, 0.05, m.doorSteel, doorWidth / 2, 1.12, 0, 0.6)
      panelPivot.add(panel)
      const handle = box(0.03, 0.18, 0.05, m.darkSteel, doorWidth - 0.12, 1.05, 0.05)
      panelPivot.add(handle)
      root.add(panelPivot)

      const faceMat = new THREE.MeshStandardMaterial({
        color: 0x020202,
        emissive: 0xffffff,
        emissiveMap: faceTexture(face),
        emissiveIntensity: 2.2,
        roughness: 0.3,
      })
      const facePanel = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), faceMat)
      facePanel.position.set(0, 2.85, 0.125)
      root.add(facePanel)
      root.add(box(0.58, 0.58, 0.04, m.darkSteel, 0, 2.85, 0.09))

      const lampMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff8a2a, emissiveIntensity: 1.5 })
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), lampMat)
      lamp.position.set(slotWidth / 2 - 0.05, 2.35, 0.1)
      root.add(lamp)

      // Trap panel hinged on the door side, swinging down toward the void.
      const trapPivot = new THREE.Group()
      trapPivot.position.set(0, 0, 0.05)
      const trapDepth = 1.35
      const trap = gratingFloor(m.grating, slotWidth - 0.03, trapDepth, 0)
      trapPivot.add(trap)
      trapPivot.add(box(slotWidth - 0.03, 0.02, 0.06, m.hazard, 0, -0.012, trapDepth - 0.03))
      trapPivot.add(box(0.05, 0.02, trapDepth, m.hazard, -slotWidth / 2 + 0.04, -0.012, trapDepth / 2))
      root.add(trapPivot)

      this.group.add(root)
      this.disposables.push(faceMat, lampMat)
      doors.push({ slot, face, x, fromX, root, panelPivot, trapPivot, faceMat, lampMat, openT: 0, trapT: 0, rattle: 0 })
    })

    this.addLamp(-GATE_HALF - 0.05, 2.6, gz + 1.9)
    if (index % 2 === 1) this.addLamp(GATE_HALF + 0.05, 2.6, gz - 1.4)
    return { index, z: gz, slotWidth, doors, swapT: preSwap ? 0 : 1, swapping: false }
  }

  private addLamp(x: number, y: number, z: number) {
    const m = this.mats
    this.group.add(box(0.07, y, 0.07, m.darkSteel, x, y / 2, z))
    this.group.add(box(0.5, 0.05, 0.05, m.darkSteel, x + (x < 0 ? 0.25 : -0.25), y, z))
    const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.16, 10), m.darkSteel)
    cage.position.set(x + (x < 0 ? 0.48 : -0.48), y - 0.1, z)
    this.group.add(cage)
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), m.bulb.clone())
    bulb.position.set(cage.position.x, y - 0.19, z)
    this.group.add(bulb)
    this.bulbs.push(bulb)
    this.disposables.push(bulb.material as THREE.Material)
    this.lamps.push({ position: bulb.position.clone(), phase: Math.random() * 100 })
  }

  stopZ(gateIndex: number) {
    return this.gates[gateIndex].z + 1.75
  }

  /** Half width of solid floor at a given z, used for edge-of-walkway camera shake. */
  halfWidthAt(z: number) {
    if (z > START_SLAB.front) return START_SLAB.half
    if (z < this.endPlatformZ + 2.5) return 5
    for (const gate of this.gates) if (z <= gate.z + 2.0 && z >= gate.z - 1.6) return GATE_HALF
    return WALK_HALF
  }

  dispose() {
    this.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).geometry.dispose()
    })
    this.disposables.forEach((d) => d.dispose())
    this.group.removeFromParent()
  }
}
