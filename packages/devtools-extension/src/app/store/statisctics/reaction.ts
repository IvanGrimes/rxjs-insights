import { combineReactions, createReaction, filterActions } from '@lib/store';
import { from, map, switchMap } from 'rxjs';
import { statisticsClient } from '@app/clients/statistics';
import { statisticsActions } from '@app/store/statisctics/actions';
import { routesActions } from '@app/store/routes';
import { appBarActions } from '@app/store/app-bar';

export const statisticsReaction = combineReactions()
  .add(
    createReaction(() =>
      from(statisticsClient.getStats()).pipe(
        map((stats) =>
          statisticsActions.StatsResolved({
            stats,
          })
        )
      )
    )
  )
  .add(
    createReaction((action$) =>
      action$.pipe(
        filterActions([
          routesActions.DashboardRouteEntered,
          appBarActions.RefreshDataButtonClicked,
        ]),
        switchMap(() =>
          from(statisticsClient.getStats()).pipe(
            map((stats) => statisticsActions.StatsResolved({ stats }))
          )
        )
      )
    )
  );
