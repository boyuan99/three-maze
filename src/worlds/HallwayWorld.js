import { BaseWorld } from './BaseWorld'
import * as THREE from 'three'

// Use public asset path (served from public/assets/)
const wallTextureUrl = '/assets/Chess_Pattern.jpg'

const FAR = 1000

export class HallwayWorld extends BaseWorld {
  constructor(canvas, options = {}) {
    const defaultOptions = {
      cameraConfig: {
        position: new THREE.Vector3(0, 5, 30),
        fov: 75,
        near: 0.1,
        far: FAR
      },
      rendererConfig: {
        shadows: true,
        physicallyCorrectLights: true
      },
      useOrbitControls: true,
      controlsConfig: {
        enableDamping: true,
        dampingFactor: 0.05,
        maxDistance: FAR,
        minDistance: 1
      },
      lights: [
        {
          type: 'ambient',
          color: 0xffffff,
          intensity: 0.5
        },
        {
          type: 'point',
          color: 0xffffff,
          intensity: 1,
          position: new THREE.Vector3(0, 5, 0),
          distance: 50,
          decay: 2,
          castShadow: true
        },
        {
          type: 'point',
          color: 0xffffff,
          intensity: 1,
          position: new THREE.Vector3(0, 5, -50),
          distance: 50,
          decay: 2,
          castShadow: true
        },
        {
          type: 'point',
          color: 0xffffff,
          intensity: 1,
          position: new THREE.Vector3(0, 5, 50),
          distance: 50,
          decay: 2,
          castShadow: true
        }
      ]
    }

    super(canvas, { ...defaultOptions, ...options })
  }

  async setupScene() {
    await this.createHallway()
  }

  async createHallway() {
    // Hallway dimensions in centimeters
    const hallwayLength = 200
    const hallwayWidth = 20
    const wallHeight = 10
    const wallThickness = 1
    const blueSegmentLength = 30

    // Load texture
    const textureLoader = new THREE.TextureLoader()
    const pictureTexture = await new Promise(resolve =>
      textureLoader.load(wallTextureUrl, resolve)
    )

    pictureTexture.wrapS = THREE.RepeatWrapping
    pictureTexture.wrapT = THREE.RepeatWrapping
    pictureTexture.repeat.set(hallwayWidth / 100, hallwayLength / 100)

    // Clone texture for walls
    const wallTexture = pictureTexture.clone()
    wallTexture.repeat.set(hallwayLength / 100, wallHeight / 100)

    // Materials
    const floorMaterial = new THREE.MeshStandardMaterial({
      map: pictureTexture,
      roughness: 0.8
    })
    const sideWallMaterial = new THREE.MeshStandardMaterial({
      map: wallTexture,
      roughness: 0.8
    })
    const blueMaterial = new THREE.MeshStandardMaterial({
      color: 0x0000ff,
      roughness: 0.7,
      metalness: 0.2
    })

    // Create floor
    const floorGeometry = new THREE.BoxGeometry(hallwayWidth, wallThickness, hallwayLength - 2 * blueSegmentLength)
    const floorMesh = new THREE.Mesh(floorGeometry, floorMaterial)
    floorMesh.position.set(0, -wallThickness / 2, 0)
    floorMesh.receiveShadow = true
    this.scene.add(floorMesh)

    // Create blue floor ends
    const blueFloorGeometry = new THREE.BoxGeometry(hallwayWidth, wallThickness, blueSegmentLength)

    const blueFloor1 = new THREE.Mesh(blueFloorGeometry, blueMaterial)
    blueFloor1.position.set(0, -wallThickness / 2, hallwayLength / 2 - blueSegmentLength / 2)
    blueFloor1.receiveShadow = true
    this.scene.add(blueFloor1)

    const blueFloor2 = new THREE.Mesh(blueFloorGeometry, blueMaterial)
    blueFloor2.position.set(0, -wallThickness / 2, -(hallwayLength / 2 - blueSegmentLength / 2))
    blueFloor2.receiveShadow = true
    this.scene.add(blueFloor2)

    // Create main walls
    const wallGeometry = new THREE.BoxGeometry(wallThickness, wallHeight, hallwayLength - 2 * blueSegmentLength)

    const leftWall = new THREE.Mesh(wallGeometry, sideWallMaterial)
    leftWall.position.set(-hallwayWidth / 2 - wallThickness / 2, wallHeight / 2, 0)
    leftWall.castShadow = true
    leftWall.receiveShadow = true
    this.scene.add(leftWall)

    const rightWall = new THREE.Mesh(wallGeometry, sideWallMaterial)
    rightWall.position.set(hallwayWidth / 2 + wallThickness / 2, wallHeight / 2, 0)
    rightWall.castShadow = true
    rightWall.receiveShadow = true
    this.scene.add(rightWall)

    // Create blue wall ends
    const blueWallGeometry = new THREE.BoxGeometry(wallThickness, wallHeight, blueSegmentLength)

    const positions = [
      { x: -hallwayWidth / 2 - wallThickness / 2, z: hallwayLength / 2 - blueSegmentLength / 2 },
      { x: hallwayWidth / 2 + wallThickness / 2, z: hallwayLength / 2 - blueSegmentLength / 2 },
      { x: -hallwayWidth / 2 - wallThickness / 2, z: -(hallwayLength / 2 - blueSegmentLength / 2) },
      { x: hallwayWidth / 2 + wallThickness / 2, z: -(hallwayLength / 2 - blueSegmentLength / 2) }
    ]

    positions.forEach(pos => {
      const blueWall = new THREE.Mesh(blueWallGeometry, blueMaterial)
      blueWall.position.set(pos.x, wallHeight / 2, pos.z)
      blueWall.castShadow = true
      blueWall.receiveShadow = true
      this.scene.add(blueWall)
    })

    // Create front and back walls
    const endWallGeometry = new THREE.BoxGeometry(hallwayWidth, wallHeight, wallThickness)

    const frontWall = new THREE.Mesh(endWallGeometry, blueMaterial)
    frontWall.position.set(0, wallHeight / 2, hallwayLength / 2 + wallThickness / 2)
    frontWall.castShadow = true
    frontWall.receiveShadow = true
    this.scene.add(frontWall)

    const backWall = new THREE.Mesh(endWallGeometry, blueMaterial)
    backWall.position.set(0, wallHeight / 2, -(hallwayLength / 2 + wallThickness / 2))
    backWall.castShadow = true
    backWall.receiveShadow = true
    this.scene.add(backWall)
  }
}