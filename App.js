import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import MapView, { Heatmap } from 'react-native-maps';
import * as Location from 'expo-location';
import { Audio } from 'expo-av';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
const CALIBRATION_OFFSET = Number(process.env.CALIBRATION_OFFSET || 95);

const INITIAL_REGION = {
  latitude: 40.7128,
  longitude: -74.006,
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

const deriveRadiusMeters = (region) => Math.max((region.longitudeDelta * 111320) / 2, 100);

export default function App() {
  const [region, setRegion] = useState(INITIAL_REGION);
  const [timeFilter, setTimeFilter] = useState('all');
  const [heatmapPoints, setHeatmapPoints] = useState([]);
  const [latestReading, setLatestReading] = useState('--');
  const [areaReport, setAreaReport] = useState(null);

  const fetchHeatmap = useCallback(async (currentRegion, currentTimeFilter) => {
    const radius = deriveRadiusMeters(currentRegion);
    const params = new URLSearchParams({
      lat: String(currentRegion.latitude),
      lng: String(currentRegion.longitude),
      radius: String(radius),
      time_filter: currentTimeFilter,
    });

    const response = await fetch(`${API_BASE_URL}/api/readings/heatmap?${params.toString()}`);
    if (!response.ok) {
      throw new Error('Failed to load heatmap data.');
    }

    const data = await response.json();
    setHeatmapPoints(
      data.map((point) => ({
        latitude: Number(point.latitude),
        longitude: Number(point.longitude),
        weight: Number(point.weight),
      }))
    );
  }, []);

  useEffect(() => {
    fetchHeatmap(region, timeFilter).catch(() => {
      setHeatmapPoints([]);
    });
  }, [fetchHeatmap, region, timeFilter]);

  const takeReading = useCallback(async () => {
    const micPermission = await Audio.requestPermissionsAsync();
    if (!micPermission.granted) {
      return;
    }

    const locationPermission = await Location.requestForegroundPermissionsAsync();
    if (!locationPermission.granted) {
      return;
    }

    const position = await Location.getCurrentPositionAsync({});
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

    const recording = new Audio.Recording();
    await recording.prepareToRecordAsync({
      android: {
        extension: '.m4a',
        outputFormat: Audio.AndroidOutputFormat.MPEG_4,
        audioEncoder: Audio.AndroidAudioEncoder.AAC,
        sampleRate: 44100,
        numberOfChannels: 1,
        bitRate: 128000,
      },
      ios: {
        extension: '.m4a',
        outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
        audioQuality: Audio.IOSAudioQuality.HIGH,
        sampleRate: 44100,
        numberOfChannels: 1,
        bitRate: 128000,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
      web: {},
      isMeteringEnabled: true,
    });

    await recording.startAsync();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await recording.stopAndUnloadAsync();
    const status = await recording.getStatusAsync();

    const dbfs = typeof status.metering === 'number' ? status.metering : -60;
    const decibel = Number((dbfs + CALIBRATION_OFFSET).toFixed(1));
    setLatestReading(decibel.toFixed(1));

    await fetch(`${API_BASE_URL}/api/readings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        decibel,
      }),
    });

    await fetchHeatmap(region, timeFilter);
  }, [fetchHeatmap, region, timeFilter]);

  const onMapPress = useCallback(async (event) => {
    const { latitude, longitude } = event.nativeEvent.coordinate;
    const delta = 0.005;
    const params = new URLSearchParams({
      minLng: String(longitude - delta),
      minLat: String(latitude - delta),
      maxLng: String(longitude + delta),
      maxLat: String(latitude + delta),
    });

    const response = await fetch(`${API_BASE_URL}/api/readings/report?${params.toString()}`);
    if (!response.ok) {
      return;
    }

    const report = await response.json();
    setAreaReport(report);
  }, []);

  const heatmapData = useMemo(() => heatmapPoints, [heatmapPoints]);

  return (
    <View style={styles.container}>
      <Button title="Take Reading" onPress={takeReading} testID="take-reading-button" />
      <Text testID="db-reading-display" style={styles.readingText}>{`Latest dB: ${latestReading}`}</Text>

      <View style={styles.filters}>
        <Button title="Last Hour" onPress={() => setTimeFilter('hour')} testID="time-filter-hour" />
        <Button title="Last 24 Hours" onPress={() => setTimeFilter('day')} testID="time-filter-day" />
        <Button title="All Time" onPress={() => setTimeFilter('all')} testID="time-filter-all" />
      </View>

      <MapView
        style={styles.map}
        testID="map-view"
        initialRegion={INITIAL_REGION}
        onRegionChangeComplete={setRegion}
        onPress={onMapPress}
      >
        <Heatmap points={heatmapData} radius={30} opacity={0.8} />
      </MapView>

      {areaReport ? (
        <View style={styles.reportContainer} testID="area-report-container">
          <Text>{`Average dB: ${areaReport.averageDecibel ?? 'N/A'}`}</Text>
          <Text>{`Peak dB: ${areaReport.peakDecibel ?? 'N/A'}`}</Text>
          <Text>{`Readings: ${areaReport.readingCount}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 48,
  },
  readingText: {
    marginTop: 12,
    marginHorizontal: 16,
    fontSize: 16,
    fontWeight: '600',
  },
  filters: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: 12,
  },
  map: {
    flex: 1,
  },
  reportContainer: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 8,
    padding: 12,
  },
});
