import * as THREE from 'three';
import wallTextureUrl from '../assets/patterns/Chess_Pattern.jpg';

export function createTexturedHallway() {
    const group = new THREE.Group();

    // Hallway dimensions and parameters in centimeters
    const hallwayLength = 200; // centimeters (2 meters * 100)
    const hallwayWidth = 20; // centimeters (0.2 meters * 100)
    const wallHeight = 10; // centimeters (0.1 meters * 100)
    const wallThickness = 1; // thickness of the walls in centimeters
    const blueSegmentLength = 30; // 30 cm

    // Load the picture texture for the floor and walls
    const textureLoader = new THREE.TextureLoader();
    const pictureTexture = textureLoader.load(wallTextureUrl);
    pictureTexture.wrapS = THREE.RepeatWrapping;
    pictureTexture.wrapT = THREE.RepeatWrapping;
    pictureTexture.repeat.set(hallwayWidth / 100, hallwayLength / 100);

    // Clone the texture for side walls and adjust its repeat property
    const wallTexture = textureLoader.load(wallTextureUrl);
    wallTexture.wrapS = THREE.RepeatWrapping;
    wallTexture.wrapT = THREE.RepeatWrapping;
    wallTexture.repeat.set(hallwayLength / 100, hallwayWidth / 100); // Adjusted for side walls' aspect ratio

    // Floor and main wall material using the picture
    const floorMaterial = new THREE.MeshStandardMaterial({ map: pictureTexture });
    const sideWallMaterial = new THREE.MeshStandardMaterial({ map: wallTexture });

    // Blue material for the ends remains unchanged
    const blueMaterial = new THREE.MeshStandardMaterial({ color: 0x0000ff });

    // Function to create wall segments
    const createSegment = (geometry, material, x, y, z, rx, ry, rz) => {
        const segment = new THREE.Mesh(geometry, material);
        segment.position.set(x, y, z);
        segment.rotation.x = rx;
        segment.rotation.y = ry;
        segment.rotation.z = rz;
        group.add(segment);
    };

    // Main segments
    const floorGeometryMain = new THREE.BoxGeometry(hallwayWidth, wallThickness, hallwayLength - 2 * blueSegmentLength);
    const floorGeometryEnds = new THREE.BoxGeometry(hallwayWidth, wallThickness, blueSegmentLength);
    const wallGeometryMain = new THREE.BoxGeometry(wallThickness, wallHeight, hallwayLength - 2 * blueSegmentLength);
    const wallGeometryEnds = new THREE.BoxGeometry(wallThickness, wallHeight, blueSegmentLength);
    const wallGeometrySide = new THREE.BoxGeometry(hallwayWidth, wallHeight, wallThickness);

    // Main floor segments
    createSegment(floorGeometryMain, floorMaterial, 0, -wallThickness / 2, 0, 0, 0, 0);
    createSegment(floorGeometryEnds, blueMaterial, 0, -wallThickness / 2, hallwayLength / 2 - blueSegmentLength / 2, 0, 0, 0);
    createSegment(floorGeometryEnds, blueMaterial, 0, -wallThickness / 2, -(hallwayLength / 2 - blueSegmentLength / 2), 0, 0, 0);

    // Main wall segments (without blue ends)
    createSegment(wallGeometryMain, sideWallMaterial, -hallwayWidth / 2 - wallThickness / 2, wallHeight / 2, 0, 0, 0, 0);
    createSegment(wallGeometryMain, sideWallMaterial, hallwayWidth / 2 + wallThickness / 2, wallHeight / 2, 0, 0, 0, 0);

    // Blue end segments
    createSegment(wallGeometryEnds, blueMaterial, -hallwayWidth / 2 - wallThickness / 2, wallHeight / 2, hallwayLength / 2 - blueSegmentLength / 2, 0, 0, 0);
    createSegment(wallGeometryEnds, blueMaterial, hallwayWidth / 2 + wallThickness / 2, wallHeight / 2, hallwayLength / 2 - blueSegmentLength / 2, 0, 0, 0);
    createSegment(wallGeometryEnds, blueMaterial, -hallwayWidth / 2 - wallThickness / 2, wallHeight / 2, -hallwayLength / 2 + blueSegmentLength / 2, 0, 0, 0);
    createSegment(wallGeometryEnds, blueMaterial, hallwayWidth / 2 + wallThickness / 2, wallHeight / 2, -hallwayLength / 2 + blueSegmentLength / 2, 0, 0, 0);

    // Front and back walls (entirely blue)
    createSegment(wallGeometrySide, blueMaterial, 0, wallHeight / 2, hallwayLength / 2 + wallThickness / 2, 0, 0, 0);
    createSegment(wallGeometrySide, blueMaterial, 0, wallHeight / 2, -hallwayLength / 2 - wallThickness / 2, 0, 0, 0);

    return group;
}