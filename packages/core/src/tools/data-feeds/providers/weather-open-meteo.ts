/**
 * Open-Meteo — free weather API, no API key required.
 * https://open-meteo.com/
 */
import { registerDataFeedProvider } from "../provider-registry.js";
import { fetchJson } from "../shared.js";

export interface WeatherQuery {
  /** Latitude in decimal degrees. */
  lat: number;
  /** Longitude in decimal degrees. */
  lon: number;
  /** Forecast horizon in days (1-16, default 1). */
  days?: number;
  /** Unit system. Default metric (Celsius, km/h, mm). */
  units?: "metric" | "imperial";
}

export interface WeatherResult {
  current: {
    temperature: number;
    apparentTemperature: number;
    humidity: number;
    windSpeed: number;
    windDirection: number;
    weatherCode: number;
    description: string;
    isDay: boolean;
    observedAt: string;
  };
  daily: Array<{
    date: string;
    tempMin: number;
    tempMax: number;
    precipitation: number;
    weatherCode: number;
    description: string;
  }>;
  units: { temperature: string; wind: string; precipitation: string };
  location: { latitude: number; longitude: number; timezone: string };
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    weather_code: number;
    is_day: number;
  };
  current_units: { temperature_2m: string; wind_speed_10m: string };
  daily: {
    time: string[];
    temperature_2m_min: number[];
    temperature_2m_max: number[];
    precipitation_sum: number[];
    weather_code: number[];
  };
  daily_units: { precipitation_sum: string };
}

registerDataFeedProvider<WeatherQuery, WeatherResult>({
  id: "open-meteo",
  category: "weather",
  description: "Open-Meteo — free global weather forecast (no API key required).",
  homepage: "https://open-meteo.com/",
  requiresApiKey: false,

  async fetch(query, ctx) {
    const days = Math.min(Math.max(Math.round(query.days ?? 1), 1), 16);
    const tempUnit = query.units === "imperial" ? "fahrenheit" : "celsius";
    const windUnit = query.units === "imperial" ? "mph" : "kmh";
    const precipUnit = query.units === "imperial" ? "inch" : "mm";

    const params = new URLSearchParams({
      latitude: String(query.lat),
      longitude: String(query.lon),
      current: [
        "temperature_2m", "apparent_temperature", "relative_humidity_2m",
        "wind_speed_10m", "wind_direction_10m", "weather_code", "is_day",
      ].join(","),
      daily: [
        "temperature_2m_min", "temperature_2m_max", "precipitation_sum", "weather_code",
      ].join(","),
      forecast_days: String(days),
      timezone: "auto",
      temperature_unit: tempUnit,
      wind_speed_unit: windUnit,
      precipitation_unit: precipUnit,
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    ctx.log.debug({ url }, "open-meteo fetch");
    const data = await fetchJson<OpenMeteoResponse>(url, { trusted: true, signal: ctx.signal });

    return {
      current: {
        temperature: data.current.temperature_2m,
        apparentTemperature: data.current.apparent_temperature,
        humidity: data.current.relative_humidity_2m,
        windSpeed: data.current.wind_speed_10m,
        windDirection: data.current.wind_direction_10m,
        weatherCode: data.current.weather_code,
        description: describeWmo(data.current.weather_code),
        isDay: data.current.is_day === 1,
        observedAt: data.current.time,
      },
      daily: data.daily.time.map((date, i) => ({
        date,
        tempMin: data.daily.temperature_2m_min[i] ?? 0,
        tempMax: data.daily.temperature_2m_max[i] ?? 0,
        precipitation: data.daily.precipitation_sum[i] ?? 0,
        weatherCode: data.daily.weather_code[i] ?? 0,
        description: describeWmo(data.daily.weather_code[i] ?? 0),
      })),
      units: {
        temperature: data.current_units.temperature_2m,
        wind: data.current_units.wind_speed_10m,
        precipitation: data.daily_units.precipitation_sum,
      },
      location: {
        latitude: data.latitude,
        longitude: data.longitude,
        timezone: data.timezone,
      },
    };
  },
});

// WMO weather interpretation codes — https://open-meteo.com/en/docs (Variables → weathercode)
function describeWmo(code: number): string {
  const map: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snow fall", 73: "Moderate snow fall", 75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
  };
  return map[code] ?? `Unknown (code ${code})`;
}
