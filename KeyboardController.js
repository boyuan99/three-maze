

export class KeyboardController {
    constructor(renderer) {
        this.keyMap = {};
        this.isJumping = false;

        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement === renderer.domElement) {
                document.addEventListener('keydown', this.onDocumentKey);
                document.addEventListener('keyup', this.onDocumentKey);
            } else {
                document.removeEventListener('keydown', this.onDocumentKey);
                document.removeEventListener('keyup', this.onDocumentKey);
            }
        });
    }

    onDocumentKey = (event) => {
        this.keyMap[event.code] = event.type === 'keydown';
    };
}
