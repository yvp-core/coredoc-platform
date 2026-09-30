import { CheckCircle, DangerTriangle } from '@solar-icons/react';
import { Circle } from 'lucide-react';

import { Badge } from './ui/badge';
import { Spinner } from './ui/spinner';
import type { RepositoryStatus } from '../types/project';

export const getBadge = (status: RepositoryStatus) => {
  switch (status) {
    case 'checking':
      return (
        <Badge variant="initial" className="shrink-0">
          <Spinner />
          Checking status
        </Badge>
      );
    case 'status_unavailable':
      return (
        <Badge variant="warning" className="shrink-0">
          <DangerTriangle weight="Bold" className="text-content-tag-warning" />
          Status unavailable
        </Badge>
      );
    // case 'graph_not_started':
    //   return (
    //     <Badge variant="initial" className="shrink-0">
    //       <span className="text-xs leading-4 text-content-secondary w-3 text-center">•</span>
    //       No graph
    //     </Badge>
    //   );
    case 'not_started':
      return (
        <Badge variant="initial" className="shrink-0">
          <span className="text-xs leading-4 text-content-secondary w-3 text-center">•</span>
          Not started
        </Badge>
      );
    case 'parser_creation':
      return (
        <Badge variant="info" className="shrink-0">
          <Spinner />
          Parser creation
        </Badge>
      );
    case 'parsing':
      return (
        <Badge variant="info" className="shrink-0">
          <Spinner />
          Parsing
        </Badge>
      );
    case 'parsed':
      return (
        <Badge variant="info" className="shrink-0">
          <CheckCircle weight="Outline" className="text-content-secondary" />
          Parsed
        </Badge>
      );
    case 'parsed_pending_review':
      return (
        <Badge variant="info" className="shrink-0">
          <Circle className="size-4 text-content-secondary" />
          Ready for review
        </Badge>
      );
    case 'approved':
      return (
        <Badge variant="info" className="shrink-0">
          <Circle className="size-4 text-content-secondary" />
          Approved
        </Badge>
      );
    case 'approval_stale':
      return (
        <Badge variant="warning" className="shrink-0">
          <DangerTriangle weight="Bold" className="text-content-tag-warning" />
          Re-parse required
        </Badge>
      );
    case 'summarising':
      return (
        <Badge variant="info" className="shrink-0">
          <Spinner />
          Summarising
        </Badge>
      );
    // case 'summarised':
    //   return (
    //     <Badge variant="success" className="shrink-0">
    //       <CheckCircle weight="Bold" className="text-content-tag-success" />
    //       Summarised
    //     </Badge>
    //   );
    case 'creating_graph':
      return (
        <Badge variant="info" className="shrink-0">
          <Spinner />
          Building Graph
        </Badge>
      );
    // case 'graph_up_to_date':
    //   return (
    //     <Badge variant="success" className="shrink-0">
    //       <CheckCircle weight="Bold" className="text-content-tag-success" />
    //       Graph up to date
    //     </Badge>
    //   );
    case 'graph_needs_update':
      return (
        <Badge variant="warning" className="shrink-0">
          <DangerTriangle weight="Bold" className="text-content-tag-warning" />
          Required upd.
        </Badge>
      );
    case 'updating_graph':
      return (
        <Badge variant="info" className="shrink-0">
          <Spinner />
          Updating Graph
        </Badge>
      );
    // default:
    //   return (
    //     <Badge variant="initial" className="shrink-0">
    //       <span className="text-xs leading-4 text-content-secondary w-3 text-center">•</span>
    //       Unknown
    //     </Badge>
    //   );
  }
};
