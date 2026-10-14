import type { Filters, SpatialFilter } from '@carto/api-client';
import type { WidgetDoc } from '../lib/mapDoc';
import type { LoadedDataset } from '../map/prepareMap';
import { Widget } from './Widget';

export interface WidgetsColumnProps {
  widgets: WidgetDoc[];
  datasets: LoadedDataset[];
  filters: Record<string, Filters>;
  spatialFilter?: SpatialFilter;
  onFilter: (datasetId: string, filters: Filters) => void;
}

export function WidgetsColumn({ widgets, datasets, filters, spatialFilter, onFilter }: WidgetsColumnProps) {
  if (!widgets.length) return <p className="panel muted">No widgets yet.</p>;
  return (
    <div className="widgets">
      {widgets.map((w) => (
        <section key={w.id} className="widget">
          <h3>{w.title}</h3>
          <Widget
            widget={w}
            dataset={datasets.find((d) => d.id === w.dataSource)}
            filters={filters[w.dataSource] ?? {}}
            spatialFilter={spatialFilter}
            onFilter={(f) => onFilter(w.dataSource, f)}
          />
        </section>
      ))}
    </div>
  );
}
