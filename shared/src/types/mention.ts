/**
 * Mention token resolution for text export paths.
 *
 * Mention tokens are stored as plain text in note.content:
 *   @agent-{id}   -> reference to an agent/assistant node
 *   +node-{id}    -> reference to any canvas node
 *   $branch-{id}  -> reference to a canvas node
 *   #tag-{name}   -> tag reference
 */
export namespace Mention {
  const AGENT_RE = /@agent-([\w-]+)/g
  const NODE_RE = /\+node-([\w-]+)/g
  const BRANCH_RE = /\$branch-([\w-]+)/g
  const TAG_RE = /#tag-([\w-]+)/g

  /**
   * Expand mention tokens in a content string to their referenced text.
   * One level deep: no recursion, so cycles cannot explode.
   */
  export const expandTokens = (
    text: string,
    noteMap: Map<string, { content: string }>,
  ): string =>
    text
      .replace(AGENT_RE, (_, id) => noteMap.get(id)?.content?.trim() ?? '')
      .replace(NODE_RE, (_, id) => noteMap.get(id)?.content?.trim() ?? '')
      .replace(BRANCH_RE, (_, id) => noteMap.get(id)?.content?.trim() ?? '')
      .replace(TAG_RE, (_, tag) => `#${tag}`)
}
