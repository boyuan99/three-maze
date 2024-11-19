import * as THREE from "three";

export class FollowCam {
    constructor(scene, camera, renderer) {
        this.camera = camera;
        this.pivot = new THREE.Object3D();
        this.yaw = new THREE.Object3D();
        this.pitch = new THREE.Object3D();

        this.yaw.position.y = 0.75;

        scene.add(this.pivot);
        this.pivot.add(this.yaw);
        this.yaw.add(this.pitch);
        this.pitch.add(camera);

        // Debugging
        console.log("FollowCam initialized");

        // Directly attach event listeners
        renderer.domElement.addEventListener('mousemove', this.onDocumentMouseMove);
        renderer.domElement.addEventListener('wheel', this.onDocumentMouseWheel);

        document.addEventListener('pointerlockchange', () => {
            console.log("Pointer lock change detected");
            if (document.pointerLockElement === renderer.domElement) {
                console.log("Pointer lock enabled");
            } else {
                console.log("Pointer lock disabled");
            }
        });
    }

    onDocumentMouseMove = (event) => {
        this.yaw.rotation.y -= event.movementX * 0.002;
        const v = this.pitch.rotation.x - event.movementY * 0.002;
        if (v > -Math.PI / 2 && v < Math.PI / 2) {
            this.pitch.rotation.x = v;
        }
    };

    onDocumentMouseWheel = (e) => {
        e.preventDefault();
        const v = this.camera.position.z + e.deltaY * 0.005;

        // limit range
        if (v >= 0.4 && v <= 500) {
            this.camera.position.z = v;
        }
    };

    update(target) {
        this.pivot.position.lerp(target.position, 0.1);
    }
}
