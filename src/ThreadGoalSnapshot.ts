import type {UpdateSessionEvent} from "./ACPSessionConnection";
import {AIR_GOAL_KEY, withAirMeta} from "./AirExtension";
import {type GoalSnapshot, type GoalStatus} from "./GoalExtension";
import type {ThreadGoal} from "./app-server/v2";

export type ThreadGoalSnapshot = GoalSnapshot;

function toGoalStatus(status: ThreadGoal["status"]): GoalStatus {
    switch (status) {
        case "active":
        case "paused":
        case "blocked":
        case "complete":
            return status;
        case "usageLimited":
        case "budgetLimited":
            return "limited";
    }
}

export function toThreadGoalSnapshot(goal: ThreadGoal): ThreadGoalSnapshot {
    return {
        objective: goal.objective.trim(),
        status: toGoalStatus(goal.status),
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAtEpochSeconds: goal.createdAt,
        updatedAtEpochSeconds: goal.updatedAt,
    };
}

export function sameThreadGoalSnapshot(
    left: ThreadGoalSnapshot | null | undefined,
    right: ThreadGoalSnapshot | null,
): boolean {
    if (left === undefined) return false;
    if (left === null || right === null) return left === right;
    return left.objective === right.objective
        && left.status === right.status
        && left.tokenBudget === right.tokenBudget
        && left.createdAtEpochSeconds === right.createdAtEpochSeconds;
}

/** Keep the Core goal snapshot on every connection; add AIR metadata when negotiated. */
export function goalSessionInfoUpdate(goal: ThreadGoalSnapshot | null, airClient: boolean): UpdateSessionEvent | null {
    return {
        sessionUpdate: "session_info_update",
        _meta: {...(airClient ? withAirMeta(undefined, AIR_GOAL_KEY, goal) : {}), lody: {goal}},
    };
}
