export class UI {
    constructor(renderer) {
        this.renderer = renderer;
        this.blocker = document.getElementById('blocker');
        this.instructions = document.getElementById('instructions');
        const startButton = document.getElementById('startButton');

        startButton.addEventListener('click', () => {
            renderer.domElement.requestPointerLock();
        });

        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement === this.renderer.domElement) {
                this.blocker.style.display = 'none';
            } else {
                this.blocker.style.display = 'block';
            }
        });
    }
}
