import { LaunchNotReadyError } from "./errors.js";
/**
 * Preview plans may be built against a pinned-but-not-yet-deployed router.
 * Every path that can produce or persist signed bytes must call this guard.
 */
export function assertLaunchPlanReady(plan) {
    const reasons = [...(plan.readiness?.reasons ?? [])];
    if (plan.rewardRouter.deploymentStatus !== "deployed" &&
        !reasons.includes("REWARD_ROUTER_NOT_DEPLOYED")) {
        reasons.push("REWARD_ROUTER_NOT_DEPLOYED");
    }
    if (plan.rewardRouter.deploymentStatus !== "deployed" ||
        plan.readiness?.readyForSubmission !== true) {
        throw new LaunchNotReadyError(reasons.length === 0 ? ["plan readiness was not affirmed"] : reasons);
    }
}
