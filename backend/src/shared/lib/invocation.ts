// Backend-wide "who is running this, in which arrangement" context.
// Every privileged HTTP entry point (actions, unifiers, future workflows) takes
// one of these as its first argument. It is extracted once at the route edge
// (`paramId` + `authUserId`) so controllers never touch Express.
export type InvocationCtx = {
  arrangementId: string;
  userId: string;
};
