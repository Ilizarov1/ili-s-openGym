/**
 * Small SVG charts for the progress views.
 *
 * Geometry may be hard-coded here (it is drawing, not page styling), while every
 * colour comes from the active theme. Both charts render an empty label instead of
 * collapsing, and a single point is drawn as one centred dot rather than a line of
 * zero length.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '../ThemeProvider';
import { Text } from '../components/Text';

export type ChartPoint = {
  /** Epoch milliseconds or any ordered x value. */
  x: number;
  y: number;
  /** Short axis label, usually MM/DD. */
  label?: string;
};

export type LineChartProps = {
  points: readonly ChartPoint[];
  height?: number;
  unit?: string;
  emptyLabel?: string;
  accessibilityLabel: string;
  onPointPress?: (index: number) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type ChartBar = {
  label: string;
  value: number;
};

export type BarChartProps = {
  data: readonly ChartBar[];
  height?: number;
  unit?: string;
  emptyLabel?: string;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  chart: {
    width: '100%',
    overflow: 'hidden',
  },
  empty: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});

function tickText(value: number): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  const factor = digits === 0 ? 1 : digits === 1 ? 10 : 100;
  return String(Math.round(value * factor) / factor + 0);
}

function niceStep(range: number): number {
  if (!(range > 0)) return 1;
  const raw = range / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const candidate of [1, 2, 2.5, 5, 10]) {
    if (raw <= candidate * power) return candidate * power;
  }
  return 10 * power;
}

function EmptyChart({
  height,
  label,
  style,
  testID,
  accessibilityLabel,
}: {
  height: number;
  label: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      accessible
      style={[styles.empty, { height }, style]}
      testID={testID}
    >
      <Text tone="secondary" variant="footnote">
        {label}
      </Text>
      <View
        style={{
          marginTop: theme.space.xs,
          width: theme.space.xxxl,
          height: theme.sizes.hairline,
          backgroundColor: theme.colors.sepOp,
        }}
      />
    </View>
  );
}

export function LineChart({
  points,
  height = 160,
  unit = '',
  emptyLabel = '暂无数据',
  accessibilityLabel,
  onPointPress,
  style,
  testID,
}: LineChartProps): React.ReactElement {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const handleLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setWidth(current => (current === next ? current : next));
  };

  if (points.length === 0) {
    return (
      <EmptyChart
        accessibilityLabel={accessibilityLabel}
        height={height}
        label={emptyLabel}
        style={style}
        testID={testID}
      />
    );
  }

  if (width <= 0) {
    return (
      <View
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="image"
        accessible
        onLayout={handleLayout}
        style={[{ height }, style]}
        testID={testID}
      />
    );
  }

  const ordered = points
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
  if (ordered.length === 0) {
    return (
      <EmptyChart
        accessibilityLabel={accessibilityLabel}
        height={height}
        label={emptyLabel}
        style={style}
        testID={testID}
      />
    );
  }
  const single = ordered.length === 1;
  const P = { left: 38, right: 10, top: 12, bottom: 22 };
  const plotWidth = Math.max(1, width - P.left - P.right);
  const plotHeight = Math.max(1, height - P.top - P.bottom);

  let minY = Math.min(...ordered.map(point => point.y));
  let maxY = Math.max(...ordered.map(point => point.y));
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return (
      <EmptyChart
        accessibilityLabel={accessibilityLabel}
        height={height}
        label={emptyLabel}
        style={style}
        testID={testID}
      />
    );
  }
  if (minY === maxY) {
    const bump = Math.abs(minY) > 1 ? Math.abs(minY) * 0.1 : 1;
    minY -= bump;
    maxY += bump;
  }
  const pad = (maxY - minY) * 0.12;
  minY -= pad;
  maxY += pad;

  const firstX = ordered[0].x;
  const lastX = ordered[ordered.length - 1].x;
  const xOf = (x: number) => single || lastX === firstX
    ? P.left + plotWidth / 2
    : P.left + ((x - firstX) / (lastX - firstX)) * plotWidth;
  const yOf = (y: number) => P.top + (1 - (y - minY) / (maxY - minY)) * plotHeight;

  const step = niceStep(maxY - minY);
  const gridValues: number[] = [];
  for (let value = Math.ceil(minY / step) * step; value <= maxY + step * 0.001; value += step) {
    gridValues.push(Math.round(value / step) * step + 0);
  }

  const coords = ordered.map(point => ({ x: xOf(point.x), y: yOf(point.y) }));
  const line = coords.map(point => `${point.x},${point.y}`).join(' ');
  const baseY = height - P.bottom;
  const area = coords.length > 1
    ? `M ${coords[0].x} ${baseY} L ${coords.map(point => `${point.x} ${point.y}`).join(' L ')} L ${coords[coords.length - 1].x} ${baseY} Z`
    : null;

  // Prefer the first and last labels, then a middle one only when it has room:
  // three lifts in the same week would otherwise print their dates on top of
  // each other at the right edge of the plot.
  const desiredLabels = single ? [0] : [0, ordered.length - 1, Math.floor((ordered.length - 1) / 2)];
  const labelIndexes: number[] = [];
  for (const index of desiredLabels) {
    if (labelIndexes.some(existing => Math.abs(coords[existing].x - coords[index].x) < 96)) continue;
    labelIndexes.push(index);
  }
  labelIndexes.sort((a, b) => a - b);

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      accessible
      onLayout={handleLayout}
      style={[styles.chart, style]}
      testID={testID}
    >
      <Svg height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
        {area ? <Path d={area} fill={theme.colors.accentSoft} /> : null}

        {gridValues.map(value => {
          const y = yOf(value);
          return (
            <React.Fragment key={`grid-${value}`}>
              <Line
                stroke={theme.colors.sepOp}
                strokeWidth={1}
                x1={P.left}
                x2={width - P.right}
                y1={y}
                y2={y}
              />
              <SvgText
                fill={theme.colors.label3}
                fontSize={9.5}
                textAnchor="end"
                x={P.left - 4}
                y={y + 3}
              >
                {tickText(value)}
              </SvgText>
            </React.Fragment>
          );
        })}

        {unit ? (
          <SvgText
            fill={theme.colors.label3}
            fontSize={9.5}
            textAnchor="end"
            x={width - P.right}
            y={10}
          >
            {unit}
          </SvgText>
        ) : null}

        {coords.length > 1 ? (
          <Polyline
            fill="none"
            points={line}
            stroke={theme.colors.accent}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.5}
          />
        ) : null}

        {coords.map((point, index) => (
          <Circle
            cx={point.x}
            cy={point.y}
            fill={theme.colors.accent}
            key={`dot-${ordered[index].x}-${index}`}
            r={3.6}
            stroke={theme.colors.surface}
            strokeWidth={1.5}
          />
        ))}

        {onPointPress
          ? coords.map((point, index) => (
              <Circle
                cx={point.x}
                cy={point.y}
                fill="transparent"
                key={`hit-${ordered[index].x}-${index}`}
                onPress={() => onPointPress(index)}
                r={12}
              />
            ))
          : null}

        {labelIndexes.map((index, position) => {
          const label = ordered[index]?.label;
          if (!label) return null;
          const anchor = single
            ? 'middle'
            : position === 0
              ? 'start'
              : position === labelIndexes.length - 1
                ? 'end'
                : 'middle';
          return (
            <SvgText
              fill={theme.colors.label3}
              fontSize={9.5}
              key={`x-${label}-${index}`}
              textAnchor={anchor}
              x={coords[index]?.x ?? P.left}
              y={height - 6}
            >
              {label}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

export function BarChart({
  data,
  height = 140,
  unit = '',
  emptyLabel = '暂无数据',
  accessibilityLabel,
  style,
  testID,
}: BarChartProps): React.ReactElement {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const handleLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setWidth(current => (current === next ? current : next));
  };

  const maxValue = Math.max(0, ...data.map(item => (Number.isFinite(item.value) ? item.value : 0)));
  if (data.length === 0 || maxValue <= 0) {
    return (
      <EmptyChart
        accessibilityLabel={accessibilityLabel}
        height={height}
        label={emptyLabel}
        style={style}
        testID={testID}
      />
    );
  }

  if (width <= 0) {
    return (
      <View
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="image"
        accessible
        onLayout={handleLayout}
        style={[{ height }, style]}
        testID={testID}
      />
    );
  }

  const P = { left: 6, right: 6, top: 12, bottom: 18 };
  const plotWidth = Math.max(1, width - P.left - P.right);
  const plotHeight = Math.max(1, height - P.top - P.bottom);
  const slot = plotWidth / data.length;
  const barWidth = Math.max(1, Math.min(slot * 0.62, slot - 1));
  const baseline = height - P.bottom;

  const labelIndexes = data.length <= 7
    ? data.map((_, index) => index)
    : [...new Set([0, Math.floor((data.length - 1) / 2), data.length - 1])];

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      accessible
      onLayout={handleLayout}
      style={[styles.chart, style]}
      testID={testID}
    >
      <Svg height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
        {unit ? (
          <SvgText
            fill={theme.colors.label3}
            fontSize={9.5}
            textAnchor="end"
            x={width - P.right}
            y={10}
          >
            {unit}
          </SvgText>
        ) : null}

        <Line
          stroke={theme.colors.sepOp}
          strokeWidth={1}
          x1={P.left}
          x2={width - P.right}
          y1={baseline}
          y2={baseline}
        />

        {data.map((item, index) => {
          const value = Number.isFinite(item.value) ? Math.max(0, item.value) : 0;
          const barHeight = value > 0 ? Math.max(2, (value / maxValue) * plotHeight) : 1;
          const x = P.left + slot * index + (slot - barWidth) / 2;
          return (
            <Rect
              fill={value > 0 ? theme.colors.accent : theme.colors.surface3}
              height={barHeight}
              key={`bar-${item.label}-${index}`}
              rx={2}
              width={barWidth}
              x={x}
              y={baseline - barHeight}
            />
          );
        })}

        {labelIndexes.map((index, position) => {
          const item = data[index];
          if (!item?.label) return null;
          const anchor = position === 0
            ? 'start'
            : position === labelIndexes.length - 1
              ? 'end'
              : 'middle';
          return (
            <SvgText
              fill={theme.colors.label3}
              fontSize={9.5}
              key={`label-${item.label}-${index}`}
              textAnchor={anchor}
              x={P.left + slot * index + slot / 2}
              y={height - 6}
            >
              {item.label}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}
