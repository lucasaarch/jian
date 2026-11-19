import { z } from 'zod';

/**
 * A diagram (`diagram` Artifact) as data: boxes and the lines between them, kept as its version's
 * `content` in JSON. Its frame lays out what has no place of its own and draws it on a canvas the
 * owner pans, zooms and edits by hand, so the agent may write it with no positions at all and the
 * owner's arrangement comes back with every node placed.
 *
 * Places are in CSS pixels at full size, `y` going down, and name a node's centre: two nodes of
 * different sizes line up when their `x` or `y` agree.
 */

/** The most nodes one diagram holds: well past what still reads on a screen. */
export const DIAGRAM_NODES_MAX = 500;
export const DIAGRAM_EDGES_MAX = 1500;
export const DIAGRAM_GROUPS_MAX = 60;

/** How a node is drawn. `text` is words with no outline; `note` a sticky note. */
export const DIAGRAM_SHAPES = ['rect', 'rounded', 'ellipse', 'diamond', 'note', 'text'] as const;

/**
 * The colours a node may take, by name. The frame holds a light and a dark tone of each, so a
 * diagram reads in both themes; a hex colour could only be right in one of them.
 */
export const DIAGRAM_COLORS = [
  'gray',
  'blue',
  'teal',
  'green',
  'yellow',
  'orange',
  'red',
  'purple',
  'pink',
] as const;

// Not trimmed: what is checked must be the very id the frame looks up.
const idSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('Unique within the diagram; what edges and groups refer to.');

/** A coordinate far enough out for any real diagram, and never Infinity or NaN. */
const placeSchema = z.number().min(-1_000_000).max(1_000_000);

const diagramNodeSchema = z.strictObject({
  id: idSchema,
  label: z.string().max(300).describe('What the node says; a line break is kept.'),
  shape: z.enum(DIAGRAM_SHAPES).optional().describe('rounded when omitted.'),
  x: placeSchema.optional().describe('Its centre. Omit x and y to have it laid out.'),
  y: placeSchema.optional(),
  width: z.number().min(16).max(2000).optional().describe('Omit to fit its label.'),
  height: z.number().min(16).max(2000).optional(),
  color: z.enum(DIAGRAM_COLORS).optional(),
  group: idSchema.optional().describe('The id of the group it is drawn inside.'),
});

const diagramEdgeSchema = z.strictObject({
  id: idSchema.optional(),
  from: idSchema,
  to: idSchema,
  label: z.string().max(120).optional(),
  style: z.enum(['solid', 'dashed']).optional(),
  arrow: z.enum(['end', 'both', 'none']).optional().describe('end when omitted.'),
});

/** A frame drawn around the nodes that name it, with its label on top. */
const diagramGroupSchema = z.strictObject({
  id: idSchema,
  label: z.string().max(120),
});

/**
 * How a diagram is kept. `direction` is how the layout runs where it places nodes: top to bottom
 * (the default) or left to right.
 *
 * Every reference must name something that exists, and every id be one of a kind: a mistake is
 * refused with where it is and what was meant, for the agent to fix now, rather than drawn
 * missing a line.
 */
export const diagramContentSchema = z
  .strictObject({
    direction: z.enum(['TB', 'LR']).optional(),
    nodes: z.array(diagramNodeSchema).max(DIAGRAM_NODES_MAX),
    edges: z.array(diagramEdgeSchema).max(DIAGRAM_EDGES_MAX).optional(),
    groups: z.array(diagramGroupSchema).max(DIAGRAM_GROUPS_MAX).optional(),
  })
  .superRefine((diagram, context) => {
    const twice = (list: { id?: string | undefined }[], kind: 'nodes' | 'edges' | 'groups') => {
      const seen = new Set<string>();
      list.forEach((item, index) => {
        if (item.id === undefined) return;
        if (seen.has(item.id)) {
          context.addIssue({
            code: 'custom',
            path: [kind, index, 'id'],
            message: `"${item.id}" is the id of another of the ${kind} already.`,
          });
        }
        seen.add(item.id);
      });
      return seen;
    };
    const nodes = twice(diagram.nodes, 'nodes');
    const groups = twice(diagram.groups ?? [], 'groups');
    twice(diagram.edges ?? [], 'edges');
    // What the message offers in place of a wrong id: enough to see the mistake, never the lot.
    const known = (ids: Set<string>) => {
      const listed = [...ids].slice(0, 12).map((id) => `"${id}"`);
      if (!listed.length) return 'There are none.';
      return `They are ${listed.join(', ')}${ids.size > listed.length ? ', …' : ''}.`;
    };

    diagram.nodes.forEach((node, index) => {
      if ((node.x === undefined) !== (node.y === undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index],
          message: 'A node is placed with both x and y, or with neither to be laid out.',
        });
      }
      if (node.group !== undefined && !groups.has(node.group)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'group'],
          message: `No group has the id "${node.group}". ${known(groups)}`,
        });
      }
    });
    (diagram.edges ?? []).forEach((edge, index) => {
      for (const end of ['from', 'to'] as const) {
        if (nodes.has(edge[end])) continue;
        context.addIssue({
          code: 'custom',
          path: ['edges', index, end],
          message: `No node has the id "${edge[end]}". ${known(nodes)}`,
        });
      }
    });
  });

export type DiagramContent = z.infer<typeof diagramContentSchema>;
