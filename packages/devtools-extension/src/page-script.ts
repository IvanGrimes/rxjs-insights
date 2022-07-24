import {
  createClient,
  createDocumentEventClientAdapter,
  createInspectedWindowEvalServerAdapter,
  startServer,
} from '@lib/rpc';
import {
  Instrumentation,
  InstrumentationChannel,
} from '@app/protocols/instrumentation-status';
import { Statistics, StatisticsChannel } from '@app/protocols/statistics';
import {
  getGlobalEnv,
  ObservableLike,
  SubscriberLike,
} from '@rxjs-insights/core';
import {
  deref,
  Event,
  Observable,
  Subscriber,
  Target,
  Task,
} from '@rxjs-insights/recorder';
import { Targets, TargetsChannel } from '@app/protocols/targets';
import {
  TargetsNotifications,
  TargetsNotificationsChannel,
} from '@app/protocols/targets-notifications';
import {
  Insights,
  InsightsChannel,
  RelatedTarget,
  Relations,
  TargetState,
} from '@app/protocols/insights';
import {
  Trace,
  TraceFrame,
  Traces,
  TracesChannel,
} from '@app/protocols/traces';
import { RefsService } from './refs-service';
import { EventRef, Refs, RefsChannel, TargetRef } from '@app/protocols/refs';
import {
  getObservable,
  getPrecedingEvent,
  getRelatedDestinationTargets,
  getRelatedSourceTargets,
  getSubscriber,
  getSucceedingEvents,
  isObservableTarget,
  isSubscriberTarget,
} from '@rxjs-insights/recorder-utils';
import {
  OUT_OF_BOUNDS_MAX_TIME,
  OUT_OF_BOUNDS_MIN_TIME,
} from '@app/constants/timeframe';

const RXJS_INSIGHTS_ENABLED_KEY = 'RXJS_INSIGHTS_ENABLED';

function getTrace(event: Event | undefined): Trace {
  if (event === undefined) {
    return [];
  } else {
    const frame: TraceFrame = {
      task: {
        id: event.task.id,
        name: event.task.name,
      },
      event: refs.create(event) as EventRef,
      target: refs.create(event.target) as TargetRef,
      locations: event.target.declaration.locations,
    };
    return [frame, ...getTrace(event.precedingEvent)];
  }
}

startServer<Traces>(createInspectedWindowEvalServerAdapter(TracesChannel), {
  getTrace() {
    const env = getGlobalEnv();
    if (env) {
      const event = deref(env.tracer.getTrace()?.eventRef);
      return getTrace(event);
    } else {
      return undefined;
    }
  },
});

startServer<Statistics>(
  createInspectedWindowEvalServerAdapter(StatisticsChannel),
  {
    getStats() {
      return getGlobalEnv().recorder.getStats();
    },
  }
);

startServer<Instrumentation>(
  createInspectedWindowEvalServerAdapter(InstrumentationChannel),
  {
    getStatus() {
      switch ((window as any).RXJS_INSIGHTS_INSTALLED) {
        case true:
          return 'installed';
        case false:
          return 'not-installed';
        default:
          return 'not-available';
      }
    },

    install() {
      sessionStorage.setItem(RXJS_INSIGHTS_ENABLED_KEY, 'true');
      location.reload();
    },
  }
);

const targets: Record<number, Observable | Subscriber> = {};

startServer<Targets>(createInspectedWindowEvalServerAdapter(TargetsChannel), {
  addTarget(objectId: number) {
    const target = refs.getObject(objectId)! as Observable | Subscriber;
    targets[target.id] = target;
  },
  releaseTarget(targetId) {
    delete targets[targetId];
  },
  getTargets() {
    return Object.values(targets).map(
      (target) => refs.create(target) as TargetRef
    );
  },
});

const targetsNotificationsClient = createClient<TargetsNotifications>(
  createDocumentEventClientAdapter(TargetsNotificationsChannel)
);

const refs = new RefsService();

(window as any).REFS = refs;

startServer<Refs>(createInspectedWindowEvalServerAdapter(RefsChannel), refs);

function getStartTime(events: Event[]) {
  if (events.length === 0) {
    return OUT_OF_BOUNDS_MAX_TIME;
  } else {
    return events[0].time;
  }
}

function getEndTime(events: Event[]) {
  if (events.length === 0) {
    return OUT_OF_BOUNDS_MIN_TIME;
  } else {
    const lastEvent = events.at(-1)!;
    switch (lastEvent.type) {
      case 'error':
      case 'complete':
      case 'unsubscribe':
        return lastEvent.time;
      default:
        return OUT_OF_BOUNDS_MAX_TIME;
    }
  }
}

function addRelatedTarget(
  relations: Relations,
  target: Target,
  relation: 'sources' | 'destinations',
  relatedTargets: Target[]
) {
  const targets = relations.targets;
  if (targets[target.id] === undefined) {
    targets[target.id] = {
      ...(refs.create(target) as TargetRef),
      startTime:
        target.type === 'subscriber'
          ? getStartTime(target.events)
          : OUT_OF_BOUNDS_MIN_TIME,
      endTime:
        target.type === 'subscriber'
          ? getEndTime(target.events)
          : OUT_OF_BOUNDS_MAX_TIME,
      locations: target.declaration.locations,
      [relation]: relatedTargets.map(({ id }) => id),
    };
  } else if (targets[target.id][relation] === undefined) {
    targets[target.id][relation] = relatedTargets.map(({ id }) => id);
  }
}

function addRelatedTask(relations: Relations, task: Task) {
  const tasks = relations.tasks;
  if (tasks[task.id] === undefined) {
    tasks[task.id] = {
      id: task.id,
      name: task.name,
    };
  }
}

function addRelatedEvent(relations: Relations, event: Event) {
  const events = relations.events;
  if (events[event.time] === undefined) {
    const precedingEvent = getPrecedingEvent(event);
    const succeedingEvents = getSucceedingEvents(event);
    events[event.time] = {
      ...(refs.create(event) as EventRef),
      timestamp: event.timestamp,
      target: event.target.id,
      task: event.task.id,
      precedingEvent: precedingEvent?.time,
      succeedingEvents: succeedingEvents.map(({ time }) => time),
    };
    if (precedingEvent) {
      addRelatedEvent(relations, precedingEvent);
    }
    for (const succeedingEvent of succeedingEvents) {
      addRelatedEvent(relations, succeedingEvent);
    }
    addRelatedTask(relations, event.task);
  }
}

function collectRelatedTargets(
  targets: Set<number>,
  relations: Relations,
  target: Target,
  relation: 'sources' | 'destinations',
  getRelatedTargets: (target: Target) => Target[]
) {
  if (targets.has(target.id)) {
    return;
  }
  targets.add(target.id);
  const relatedTargets = getRelatedTargets(target);
  addRelatedTarget(relations, target, relation, relatedTargets);
  for (const event of target.events) {
    addRelatedEvent(relations, event);
  }
  for (let relatedTarget of relatedTargets) {
    collectRelatedTargets(
      targets,
      relations,
      relatedTarget,
      relation,
      getRelatedTargets
    );
  }
}

function getTargetState(target: Target): TargetState {
  const rootTarget: RelatedTarget = {
    ...(refs.create(target) as TargetRef),
    startTime:
      target.type === 'subscriber'
        ? getStartTime(target.events)
        : OUT_OF_BOUNDS_MIN_TIME,
    endTime:
      target.type === 'subscriber'
        ? getEndTime(target.events)
        : OUT_OF_BOUNDS_MAX_TIME,
    locations: target.declaration.locations,
  };
  const relations: Relations = {
    targets: {},
    events: {},
    tasks: {},
  };
  relations.targets[rootTarget.id] = rootTarget;
  collectRelatedTargets(
    new Set(),
    relations,
    target,
    'sources',
    getRelatedSourceTargets
  );

  collectRelatedTargets(
    new Set(),
    relations,
    target,
    'destinations',
    getRelatedDestinationTargets
  );

  return { target: rootTarget, relations };
}

startServer<Insights>(createInspectedWindowEvalServerAdapter(InsightsChannel), {
  getTargetState(targetId: number): TargetState | undefined {
    const target = refs.getTarget(targetId);
    if (!target) {
      return undefined;
    } else {
      return getTargetState(target);
    }
  },
});

function getTarget(maybeTarget: ObservableLike | SubscriberLike) {
  if (isSubscriberTarget(maybeTarget)) {
    return getSubscriber(maybeTarget);
  }
  if (isObservableTarget(maybeTarget)) {
    return getObservable(maybeTarget);
  }
  return undefined;
}

function inspect(maybeTarget: ObservableLike | SubscriberLike) {
  const target = getTarget(maybeTarget);
  if (target) {
    targets[target.id] = target;
    void targetsNotificationsClient.notifyTarget(
      refs.create(target) as TargetRef
    );
  }
}

(window as any).RXJS_ISNIGHTS_DEVTOOLS_INSPECT = inspect;

(window as any)['RXJS_INSIGHTS_INSTALL'] =
  sessionStorage.getItem(RXJS_INSIGHTS_ENABLED_KEY) === 'true';
