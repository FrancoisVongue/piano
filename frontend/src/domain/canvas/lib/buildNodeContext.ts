import { Edge as EdgeModel, Note } from '@piano/shared';

export function buildNodeContext(nodeId: string, nodes: any[], edges: any[]): string | undefined {
  const edgeModels = edges.map((edge: any) => ({
    sourceId: edge.source,
    targetId: edge.target,
  })) as EdgeModel.Model[];

  const parentIds = EdgeModel.getAncestorIds(nodeId, edgeModels);
  if (parentIds.length === 0) return undefined;

  const nodeMap = new Map(nodes.map((node: any) => [node.id, node]));
  const sections = parentIds
    .map((id) => nodeMap.get(id))
    .filter((node: any) => node?.data?.content && Note.capabilities(node.data).canBeAIContext)
    .map((node: any) => {
      const label = node.data.label || node.data.type || 'Note';
      return `## ${label}\n\n${node.data.content}`;
    });

  return sections.length > 0 ? `${sections.join('\n\n---\n\n')}\n` : undefined;
}
