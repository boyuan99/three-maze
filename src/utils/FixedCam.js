import * as THREE from "three";

export class FixedCam {
    constructor(scene, camera, renderer, options = {}) {
        this.camera = camera;
        this.yaw = new THREE.Object3D();
        this.pitch = new THREE.Object3D();

        this.yaw.add(this.pitch);
        this.pitch.add(camera);

        scene.add(this.yaw);

        // Only add mouse controls if not disabled
        if (!options.disableMouseControl) {
            renderer.domElement.addEventListener('mousemove', this.onDocumentMouseMove);

            document.addEventListener('pointerlockchange', () => {
                if (document.pointerLockElement === renderer.domElement) {
                    console.log("Pointer lock enabled");
                    renderer.domElement.addEventListener('mousemove', this.onDocumentMouseMove);
                } else {
                    console.log("Pointer lock disabled");
                    renderer.domElement.removeEventListener('mousemove', this.onDocumentMouseMove);
                }
            });

            // Request pointer lock on click
            renderer.domElement.addEventListener('click', () => {
                renderer.domElement.requestPointerLock();
            });
        }
    }

    onDocumentMouseMove = (event) => {
        if (document.pointerLockElement) {
            this.yaw.rotation.y -= event.movementX * 0.002;
            const v = this.pitch.rotation.x - event.movementY * 0.002;
            if (v > -Math.PI / 2 && v < Math.PI / 2) {
                this.pitch.rotation.x = v;
            }
        }
    };

    update(target) {
        this.yaw.position.copy(target.position);
    }
}
