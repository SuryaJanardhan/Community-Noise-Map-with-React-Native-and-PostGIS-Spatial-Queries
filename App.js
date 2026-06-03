import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, StatusBar } from 'react-native';
import MapView, { Heatmap } from 'react-native-maps';
import * as Location from 'expo-location';
import { Audio } from 'expo-av';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
const CALIBRATION_OFFSET = Number(process.env.EXPO_PUBLIC_CALIBRATION_OFFSET || 95);
const RECORDING_DURATION_MS = 700;
const DEFAULT_DBFS_FALLBACK = -60;
const REPORT_AREA_DELTA_DEGREES = 0.005;

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
  const [isRecording, setIsRecording] = useState(false);

  const fetchHeatmap = useCallback(async (currentRegion, currentTimeFilter) => {
    try {
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
    } catch (error) {
      console.warn(error.message);
      setHeatmapPoints([]);
    }
  }, []);

  useEffect(() => {
    fetchHeatmap(region, timeFilter);
  }, [fetchHeatmap, region, timeFilter]);

  const takeReading = useCallback(async () => {
    try {
      setIsRecording(true);
      const micPermission = await Audio.requestPermissionsAsync();
      if (!micPermission.granted) {
        setIsRecording(false);
        return;
      }

      const locationPermission = await Location.requestForegroundPermissionsAsync();
      if (!locationPermission.granted) {
        setIsRecording(false);
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

      const samples = [];
      recording.setOnRecordingStatusUpdate((status) => {
        if (status && typeof status.metering === 'number') {
          samples.push(status.metering);
        }
      });

      await recording.startAsync();
      if (typeof recording.setProgressUpdateInterval === 'function') {
        await recording.setProgressUpdateInterval(100);
      }

      await new Promise((resolve) => setTimeout(resolve, RECORDING_DURATION_MS));
      await recording.stopAndUnloadAsync();

      let dbfs = DEFAULT_DBFS_FALLBACK;
      if (samples.length > 0) {
        const validSamples = samples.filter((s) => s > -160);
        if (validSamples.length > 0) {
          dbfs = validSamples.reduce((sum, val) => sum + val, 0) / validSamples.length;
        }
      } else {
        const status = await recording.getStatusAsync();
        if (status && typeof status.metering === 'number') {
          dbfs = status.metering;
        }
      }

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
    } catch (err) {
      console.warn('Error capturing reading:', err);
    } finally {
      setIsRecording(false);
    }
  }, [fetchHeatmap, region, timeFilter]);

  const onMapPress = useCallback(async (event) => {
    try {
      const { latitude, longitude } = event.nativeEvent.coordinate;
      const params = new URLSearchParams({
        minLng: String(longitude - REPORT_AREA_DELTA_DEGREES),
        minLat: String(latitude - REPORT_AREA_DELTA_DEGREES),
        maxLng: String(longitude + REPORT_AREA_DELTA_DEGREES),
        maxLat: String(latitude + REPORT_AREA_DELTA_DEGREES),
      });

      const response = await fetch(`${API_BASE_URL}/api/readings/report?${params.toString()}`);
      if (!response.ok) {
        return;
      }

      const report = await response.json();
      setAreaReport(report);
    } catch (err) {
      console.warn('Error loading report:', err);
    }
  }, []);

  const heatmapData = useMemo(() => heatmapPoints, [heatmapPoints]);

  const getGaugeColor = (dbVal) => {
    if (dbVal === '--') return '#64748B';
    const val = Number(dbVal);
    if (val < 55) return '#10B981';
    if (val < 75) return '#F59E0B';
    return '#EF4444';
  };

  const activeColor = getGaugeColor(latestReading);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0B0F19" />

      {/* Header section */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Urban Noise Mapper</Text>
        <Text style={styles.headerSubtitle}>Crowdsourced Civic Decibel Visualizer</Text>
      </View>

      {/* Circle Gauge Container */}
      <View style={styles.gaugeContainer}>
        <View style={[styles.gaugeCircle, { borderColor: activeColor }]}>
          <Text
            testID="db-reading-display"
            data-testid="db-reading-display"
            style={[styles.gaugeValue, { color: activeColor }]}
          >
            {latestReading === '--' ? '--' : `${latestReading}`}
          </Text>
          <Text style={styles.gaugeLabel}>{latestReading === '--' ? 'NO DATA' : 'DECIBELS (dBSPL)'}</Text>
        </View>
      </View>

      {/* Control Button */}
      <View style={styles.buttonContainer}>
        <TouchableOpacity
          onPress={takeReading}
          disabled={isRecording}
          testID="take-reading-button"
          data-testid="take-reading-button"
          activeOpacity={0.7}
          style={[styles.primaryButton, isRecording && styles.disabledButton]}
        >
          <Text style={styles.primaryButtonText}>{isRecording ? 'ANALYZING...' : 'TAKE READING'}</Text>
        </TouchableOpacity>
      </View>

      {/* Time Filters */}
      <View style={styles.filtersContainer}>
        <Text style={styles.filtersLabel}>Time Filter</Text>
        <View style={styles.filtersRow}>
          <TouchableOpacity
            onPress={() => setTimeFilter('hour')}
            testID="time-filter-hour"
            data-testid="time-filter-hour"
            activeOpacity={0.7}
            style={[styles.filterButton, timeFilter === 'hour' && styles.activeFilterButton]}
          >
            <Text style={[styles.filterButtonText, timeFilter === 'hour' && styles.activeFilterButtonText]}>
              Last Hour
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setTimeFilter('day')}
            testID="time-filter-day"
            data-testid="time-filter-day"
            activeOpacity={0.7}
            style={[styles.filterButton, timeFilter === 'day' && styles.activeFilterButton]}
          >
            <Text style={[styles.filterButtonText, timeFilter === 'day' && styles.activeFilterButtonText]}>
              Last 24h
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setTimeFilter('all')}
            testID="time-filter-all"
            data-testid="time-filter-all"
            activeOpacity={0.7}
            style={[styles.filterButton, timeFilter === 'all' && styles.activeFilterButton]}
          >
            <Text style={[styles.filterButtonText, timeFilter === 'all' && styles.activeFilterButtonText]}>
              All Time
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Map View */}
      <View style={styles.mapContainer}>
        <MapView
          style={styles.map}
          testID="map-view"
          data-testid="map-view"
          initialRegion={INITIAL_REGION}
          onRegionChangeComplete={setRegion}
          onPress={onMapPress}
        >
          <Heatmap points={heatmapData} radius={35} opacity={0.8} />
        </MapView>

        {/* Bounding Box Report Display Overlay */}
        {areaReport ? (
          <View
            style={styles.reportContainer}
            testID="area-report-container"
            data-testid="area-report-container"
          >
            <View style={styles.reportHeader}>
              <Text style={styles.reportTitle}>Area Report</Text>
              <TouchableOpacity onPress={() => setAreaReport(null)} style={styles.closeButton}>
                <Text style={styles.closeButtonText}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.reportGrid}>
              <View style={styles.reportCol}>
                <Text style={styles.reportLbl}>AVERAGE</Text>
                <Text style={styles.reportVal}>
                  {areaReport.averageDecibel !== null ? `${areaReport.averageDecibel} dB` : 'N/A'}
                </Text>
              </View>
              <View style={styles.reportCol}>
                <Text style={styles.reportLbl}>PEAK</Text>
                <Text style={styles.reportVal}>
                  {areaReport.peakDecibel !== null ? `${areaReport.peakDecibel} dB` : 'N/A'}
                </Text>
              </View>
              <View style={styles.reportCol}>
                <Text style={styles.reportLbl}>SAMPLES</Text>
                <Text style={styles.reportVal}>{areaReport.readingCount}</Text>
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0F19',
  },
  header: {
    paddingHorizontal: 24,
    marginTop: 16,
    marginBottom: 8,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#F1F5F9',
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 4,
    fontWeight: '500',
  },
  gaugeContainer: {
    alignItems: 'center',
    marginVertical: 14,
  },
  gaugeCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 4,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
    shadowColor: '#00F2FE',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 4,
  },
  gaugeValue: {
    fontSize: 34,
    fontWeight: '800',
  },
  gaugeLabel: {
    fontSize: 9,
    color: '#64748B',
    marginTop: 6,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  buttonContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: '#00F2FE',
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 24,
    minWidth: 180,
    alignItems: 'center',
    shadowColor: '#00F2FE',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  disabledButton: {
    backgroundColor: '#1E293B',
    shadowOpacity: 0,
    elevation: 0,
  },
  primaryButtonText: {
    color: '#0B0F19',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  filtersContainer: {
    paddingHorizontal: 24,
    marginBottom: 16,
  },
  filtersLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  filtersRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  filterButton: {
    flex: 1,
    marginHorizontal: 4,
    backgroundColor: '#111827',
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  activeFilterButton: {
    backgroundColor: 'rgba(0, 242, 254, 0.1)',
    borderColor: '#00F2FE',
  },
  filterButtonText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '600',
  },
  activeFilterButtonText: {
    color: '#00F2FE',
    fontWeight: '700',
  },
  mapContainer: {
    flex: 1,
    overflow: 'hidden',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: '#111827',
  },
  map: {
    flex: 1,
  },
  reportContainer: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1E293B',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  reportHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
    paddingBottom: 6,
  },
  reportTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#F1F5F9',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  closeButton: {
    padding: 2,
  },
  closeButtonText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: 'bold',
  },
  reportGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  reportCol: {
    flex: 1,
    alignItems: 'center',
  },
  reportVal: {
    fontSize: 16,
    fontWeight: '800',
    color: '#00F2FE',
    marginTop: 4,
  },
  reportLbl: {
    fontSize: 9,
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
