import { FixedCam } from './FixedCam';

export class FixedFollowCam extends FixedCam {
    update(target) {
        // Call parent update for position
        super.update(target);
        // Add rotation following
        this.yaw.rotation.y = target.rotation || 0;
    }
} 