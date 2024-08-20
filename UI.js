export class UI {
    constructor(renderer) {
        this.renderer = renderer;
        this.instructions = document.getElementById('instructions');
        const startButton = document.getElementById('startButton');

        startButton.addEventListener('click', () => {
            renderer.domElement.requestPointerLock();
        });

        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement === this.renderer.domElement) {
                this.instructions.style.display = 'none';
            } else {
                this.instructions.style.display = 'block';
            }
        });
    }
}
