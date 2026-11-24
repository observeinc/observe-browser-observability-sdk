# Documentation

This folder holds supporting documents and sample files for Observe Browser RUM. The [README](../README.md) at the root of the repository describes how to install and configure the agent.

## Contents

| Path | Description |
|---|---|
| [collector/cwv-aggregation.yaml](collector/cwv-aggregation.yaml) | A sample OpenTelemetry Collector configuration that merges Core Web Vitals data before it goes to Observe. |

## Collector samples

### Core Web Vitals aggregation

Each browser sends its own `web.vitals.*` data points, and Observe bills each data point. The sample in `collector/cwv-aggregation.yaml` merges the points from all browsers into one point for each series in each 60 second window. A series is one combination of metric name, resource, and the `page`, `rating`, and `navigation_type` attributes. Traces, logs, and all other metrics go through the collector without change.

The file is a sample only.

The comments at the top of the file give the pipeline steps, the limits, the browser configuration, and the environment variables.

## Planned documents

This section is a placeholder.