// Edge 类型

import type { BaseNode } from './node.js';

export interface Edge extends BaseNode {
  source: string;
  target: string;
  relation: string;
  labels?: string[];
}

export interface EdgeFilter {
  id?: string;
  source?: string;
  target?: string;
  relation?: string;
  labels?: string[];
  limit?: number;
  offset?: number;
}
