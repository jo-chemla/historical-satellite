// import { useState } from "react";
import { DatePicker, LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";

import { LngLatBounds, LngLat } from "mapbox-gl";
// import Slider from "@mui/material/Slider";
// import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
// import PropTypes from 'prop-types'

import PlayableSlider from "./playable-slider";
import LinksSection from "./links-section";
import ExportSplitButton from "./export-split-button";
import SettingsModal from "./settings-modal";

import {
  Select,
  SelectChangeEvent,
  FormControl,
  InputLabel,
  MenuItem,
} from "@mui/material";
import { differenceInMonths, eachMonthOfInterval, isValid } from "date-fns";

import {
  sliderValToDate,
  dateToSliderVal,
  formatDate,
  planetBasemapUrl,
  BasemapsIds,
  basemapsTmsSources,
  getSliderMarks,
  MIN_DATE,
  MAX_DATE,
  useLocalStorage,
  // convertLatlonTo3857,
} from "./utilities";

const TITILER_ENDPOINT = "https://titiler.xyz"; // https://app.iconem.com/titiler
const MAX_FRAME_RESOLUTION = 2048; // 1024 - 2048
const PROMISES_BATCH_SIZE = 5;
const PROMISES_BATCH_DELAY = 2000; // 2000ms

function valueLabelFormat(value: number, minDate: Date) {
  return `${formatDate(sliderValToDate(value, minDate))}`;
}

export type MapSplitMode = "side-by-side" | "split-screen";

// Could integrate unknown TMS servers via NextGis QMS, but not needed since all major ones already there
// https://docs.nextgis.com/qms_srv_dev/doc/api.html
// https://qms.nextgis.com/api/v1/geoservices/?type=tms&search=satellite&limit=50&offset=0&submitter=&ordering=name

// -----------------------------------------------------
// Get TiTiler Crop url from params (bounds and tmsUrl)
// -----------------------------------------------------
// Download merged/cropped version of the TMS tiled using the TiTiler /cog/crop endpoint
// Uses the gdal mini-driver WMS/TMS xml string representation
// See this discussion: https://github.com/developmentseed/titiler/discussions/640
// https://titiler.xyz/cog/crop/-110,-70,110,70.png?url=%3CGDAL_WMS%3E%3CService%20name%3D%27TMS%27%3E%3CServerUrl%3Ehttp%3A%2F%2Fmt.google.com%2Fvt%2Flyrs%3Dy%26amp%3Bx%3D%24%7Bx%7D%26amp%3By%3D%24%7By%7D%26amp%3Bz%3D%24%7Bz%7D%3C%2FServerUrl%3E%3C%2FService%3E%3CDataWindow%3E%3CUpperLeftX%3E-20037508.34%3C%2FUpperLeftX%3E%3CUpperLeftY%3E20037508.34%3C%2FUpperLeftY%3E%3CLowerRightX%3E20037508.34%3C%2FLowerRightX%3E%3CLowerRightY%3E-20037508.34%3C%2FLowerRightY%3E%3CTileLevel%3E18%3C%2FTileLevel%3E%3CTileCountX%3E1%3C%2FTileCountX%3E%3CTileCountY%3E1%3C%2FTileCountY%3E%3CYOrigin%3Etop%3C%2FYOrigin%3E%3C%2FDataWindow%3E%3CProjection%3EEPSG%3A3857%3C%2FProjection%3E%3CBlockSizeX%3E256%3C%2FBlockSizeX%3E%3CBlockSizeY%3E256%3C%2FBlockSizeY%3E%3CBandsCount%3E3%3C%2FBandsCount%3E%3CCache%20%2F%3E%3C%2FGDAL_WMS%3E

const escapeTmsUrl = (url: string) =>
  url.replace("{x}", "${x}").replace("{y}", "${y}").replace("{z}", "${z}");
// const unescapeTmsUrl = (url: string) =>
//   url.replace("${x}", "{x}").replace("${y}", "{y}").replace("${z}", "{z}");
function titilerCropUrl(
  bounds: LngLatBounds,
  tmsUrl: string,
  maxFrameResolution: number = MAX_FRAME_RESOLUTION,
  titilerEndpoint: string = TITILER_ENDPOINT
) {
  // const bounds = new LngLatBounds(new LngLat(-110, -70), new LngLat(110, 70));
  // "http://mt.google.com/vt/lyrs=y&amp;x=${x}&amp;y=${y}&amp;z=${z}";
  const wmsUrl = `<GDAL_WMS><Service name='TMS'><ServerUrl>${escapeTmsUrl(
    tmsUrl
  )}</ServerUrl></Service><DataWindow><UpperLeftX>-20037508.34</UpperLeftX><UpperLeftY>20037508.34</UpperLeftY><LowerRightX>20037508.34</LowerRightX><LowerRightY>-20037508.34</LowerRightY><TileLevel>18</TileLevel><TileCountX>1</TileCountX><TileCountY>1</TileCountY><YOrigin>top</YOrigin></DataWindow><Projection>EPSG:3857</Projection><BlockSizeX>256</BlockSizeX><BlockSizeY>256</BlockSizeY><BandsCount>3</BandsCount><Cache /></GDAL_WMS>`;
  //
  // titiler returned image is in 4326 CRS, cannot be modified yet
  const coords_str = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}.tif?max_size=${maxFrameResolution}&coord-crs=epsg:4326`; // 4326
  // Bug with 3857 bounds, InternalServerError 500 on titiler, so feature-request to support dst-tms
  // const ll_3857 = convertLatlonTo3857(bounds.getSouthWest());
  // const ur_3857 = convertLatlonTo3857(bounds.getNorthEast());
  // const coords_str = `${ll_3857.x},${ll_3857.y},${ur_3857.x},${ur_3857.y}.tif?max_size=${MAX_FRAME_SIZE}&coord-crs=epsg:3857`; // 3857

  return `${titilerEndpoint}/cog/crop/${coords_str}&url=${encodeURIComponent(
    wmsUrl
  )}`;
}

// -----------------------------------------------------
// BATCHES DOWNLOAD
// Download TiTiler images by batches to avoid too many requests
// resulting in 500 internal server error
// ------------------------------------------------------
const timer = async (ms: number): Promise<any> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

// Send batches of PROMISES_BATCH_SIZE POST requests to ApolloMapping API server
async function fetchTitilerFramesBatches(gdalTranslateCmds: any, aDiv: any) {
  for (let i = 0; i < gdalTranslateCmds.length; i += PROMISES_BATCH_SIZE) {
    const chunk = gdalTranslateCmds.slice(i, i + PROMISES_BATCH_SIZE);
    // Await all promises of chunk fetching
    await Promise.all(
      chunk.map((c: any) => {
        fetch(c.downloadUrl)
          .then((response) => response.blob())
          .then((blob) => {
            console.log("downloading new ", c.downloadUrl);
            const blobURL = URL.createObjectURL(blob);
            aDiv.href = blobURL;
            aDiv.download = c.date_YYYY_MM + "_titiler.tif";
            aDiv.click();
          });
      })
    );

    await timer(PROMISES_BATCH_DELAY);
  }
}

// -----------------------------------------------------
// Component: ControlPanel
// ------------------------------------------------------
function ControlPanel(props) {
  // ---------------------------
  // Slider control
  // For slider play/pause loops
  // const [playbackSpeedFPS, setPlaybackSpeedFPS] = useState<number>(2);
  const [playbackSpeedFPS, setPlaybackSpeedFPS] = useLocalStorage(
    "playbackSpeedFPS",
    2
  );
  const handleSliderChange = (_: Event, newValue: number) => {
    props.setTimelineDate(sliderValToDate(newValue, minDate));
  };

  // const [minDate, setMinDate] = useState<Date>(MIN_DATE);
  // const [maxDate, setMaxDate] = useState<Date>(MAX_DATE);
  const [minDate, setMinDate] = useLocalStorage("export_minDate", MIN_DATE);
  const [maxDate, setMaxDate] = useLocalStorage("export_maxDate", MAX_DATE);
  const validMinDate = minDate && isValid(minDate) ? minDate : MIN_DATE;
  const validMaxDate = maxDate && isValid(maxDate) ? maxDate : MAX_DATE;
  const monthsCount = differenceInMonths(validMaxDate, validMinDate);
  const marks = getSliderMarks(validMinDate, validMaxDate);

  // const [exportInterval, setExportInterval] = useState<number>(12);
  // const [titilerEndpoint, setTitilerEndpoint] =
  //   useState<string>(TITILER_ENDPOINT);
  // const [maxFrameResolution, setMaxFrameResolution] =
  //   useState<number>(MAX_FRAME_RESOLUTION);
  const [exportInterval, setExportInterval] = useLocalStorage(
    "export_exportInterval",
    12
  );
  const [titilerEndpoint, setTitilerEndpoint] = useLocalStorage(
    "export_titilerEndpoint",
    TITILER_ENDPOINT
  );
  const [maxFrameResolution, setMaxFrameResolution] = useLocalStorage(
    "export_maxFrameResolution",
    MAX_FRAME_RESOLUTION
  );

  const handleBasemapChange = (event: SelectChangeEvent) => {
    props.setSelectedTms(event.target.value as string);
  };
  // ------------------------------------------
  // HANDLE EXPORT SAVE TO DISK
  // -------------------------------------------
  // Define function in component to use mapRef
  // Inspiration for ui overlays (date, latlon, scale) https://github.com/doersino/earthacrosstime/tree/master
  function handleExportButtonClick(exportFramesMode: boolean = true) {
    const aDiv = document.getElementById(
      "downloadFramesDiv"
    ) as HTMLAnchorElement;
    const mapRef = props.mapRef;
    const bounds = mapRef?.current?.getMap()?.getBounds();
    // Loop through each monthly basemap and download

    // const filteredDates =
    //   props.selectedTms == BasemapsIds.PlanetMonthly
    //     ? Array.from({ length: monthsCount }, (value, index) =>
    //         sliderValToDate(index, minDate)
    //       ).filter(
    //         // Test with only yearly downloads
    //         (date, index) => index >= 0 && index <= 1000 && date.getMonth() >= 0
    //       )
    //     : [false];
    const filteredDates =
      props.selectedTms == BasemapsIds.PlanetMonthly
        ? eachMonthOfInterval({
            start: validMinDate,
            end: validMaxDate,
          }).filter((_: Date, i: number) => i % exportInterval == 0)
        : [false];

    const gdalTranslateCmds = filteredDates.map((date) => {
      const tmsUrl =
        props.selectedTms == BasemapsIds.PlanetMonthly
          ? planetBasemapUrl(date)
          : basemapsTmsSources[props.selectedTms].url;
      const downloadUrl = titilerCropUrl(
        bounds,
        tmsUrl,
        maxFrameResolution,
        titilerEndpoint
      );
      const date_YYYY_MM = date
        ? formatDate(date)
        : BasemapsIds[props.selectedTms];
      console.log("downloading", aDiv.href, "to", aDiv.download);
      // METHOD 1 WILL SIMPLY OPEN IMAGE IN NEW TAB
      // aDiv.href = downloadUrl;
      // aDiv.download = date_YYYY_MM + '_titiler.tif';
      // aDiv.click();
      // The download link won't work for cross-origin requests unless the other server sends a Content-Disposition: attachment header with the response. For security reasons.

      // TRYING METHOD 2
      // https://medium.com/charisol-community/downloading-resources-in-html5-a-download-may-not-work-as-expected-bf63546e2baa
      // Also potentially useful: https://developer.mozilla.org/en-US/docs/Web/HTML/CORS_enabled_image

      const batch_cmd =
        `REM ${date_YYYY_MM}: ${downloadUrl}\n` +
        // gdal_translate command
        `%QGIS%\\bin\\gdal_translate -projwin ${bounds.getWest()} ${bounds.getNorth()} ${bounds.getEast()} ${bounds.getSouth()} -projwin_srs EPSG:4326 -outsize %BASEMAP_WIDTH% 0 "<GDAL_WMS><Service name='TMS'><ServerUrl>${escapeTmsUrl(
          tmsUrl
        )}</ServerUrl></Service><DataWindow><UpperLeftX>-20037508.34</UpperLeftX><UpperLeftY>20037508.34</UpperLeftY><LowerRightX>20037508.34</LowerRightX><LowerRightY>-20037508.34</LowerRightY><TileLevel>18</TileLevel><TileCountX>1</TileCountX><TileCountY>1</TileCountY><YOrigin>top</YOrigin></DataWindow><Projection>EPSG:3857</Projection><BlockSizeX>256</BlockSizeX><BlockSizeY>256</BlockSizeY><BandsCount>3</BandsCount><Cache /></GDAL_WMS>" %DOWNLOAD_FOLDER%\\${
          date_YYYY_MM + "_gdal.tif"
        }`;
      return { downloadUrl, batch_cmd, date_YYYY_MM };
    });

    // Write gdal_translate command to batch script with indices to original location of cropped version
    const center = mapRef?.current?.getMap()?.getCenter();
    const degrees_decimals = 4; // 4 decimals ~11m precision / 5 decimals ~1m precision
    const center_lng = center?.lng?.toFixed(degrees_decimals);
    const center_lat = center?.lat?.toFixed(degrees_decimals);
    const zoom = mapRef?.current?.getMap()?.getZoom();
    const foldername =
      props.selectedTms == BasemapsIds.PlanetMonthly
        ? `planet-monthly-${center_lng}-${center_lat}-${zoom}`
        : BasemapsIds[props.selectedTms];
    const gdal_commands =
      "REM GDAL COMMANDS to retrieve Planet Monthly Basemaps (without TiTiler)\n" +
      `REM https://historical-satellite.iconem.com/#${zoom}/${center_lng}/${center_lat} \n` +
      `REM https://www.google.fr/maps/@${center_lat},${center_lng},${zoom}z/data=!3m2!1e3!4b1 \n` +
      "REM ---\n\n" +
      `set DOWNLOAD_FOLDER=${foldername}\n` +
      "set BASEMAP_WIDTH=4096\n\n" +
      `for /f "delims=" %%i in ('dir /b/od/t:c C:\\PROGRA~1\\QGIS*') do set QGIS="C:\\PROGRA~1\\%%i"\n` +
      `mkdir ${foldername} \n\n` +
      gdalTranslateCmds.map((c) => c.batch_cmd).join("\n");
    aDiv.href =
      "data:text/plain;charset=utf-8," + encodeURIComponent(gdal_commands);
    aDiv.download = "gdal_commands.bat";

    aDiv.click();
    // METHOD 2 TEST not working, since MDN says only supported in secure contexts (HTTPS)
    // Other way using HTML Native Filesystem API
    // https://stackoverflow.com/questions/34870711/download-a-file-at-different-location-using-html5/70001920#70001920
    // https://developer.chrome.com/articles/file-system-access/#create-a-new-file
    // For desktop only: https://caniuse.com/native-filesystem-api
    console.log(gdal_commands);

    // Dowloads all frames
    if (exportFramesMode) {
      // // --- METHOD 1 ---
      // gdalTranslateCmds.forEach((c) => {
      //   fetch(c.downloadUrl)
      //     .then((response) => response.blob())
      //     .then((blob) => {
      //       console.log("downloading new ", c.downloadUrl);
      //       const blobURL = URL.createObjectURL(blob);
      //       aDiv.href = blobURL;
      //       aDiv.download = c.date_YYYY_MM + "_titiler.tif";
      //       aDiv.click();
      //     });
      // });

      // // --- METHOD 2 : batches ---
      fetchTitilerFramesBatches(gdalTranslateCmds, aDiv);
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        width: "100%",
        pointerEvents: "auto",

        bottom: 0,
        right: 0,
        left: 0,
        boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
        outline: "none",
        overflow: "visible",
        display: "flex",
        flexDirection: "column",
        flex: 1,
        zIndex: 20,
      }}
    >
      <div
        style={{
          textAlign: "center",
          padding: "30px",
          background: "#fffc",
          width: "100%",
          alignSelf: "flex-end",
          position: "relative",
          height: "auto",
        }}
      >
        <FormControl
          sx={{ m: 0, minWidth: 200, textAlign: "left" }}
          size="small"
        >
          <InputLabel id="select-label">Basemap</InputLabel>
          <Select
            labelId="demo-select-small-label"
            id="demo-select-small"
            value={props.selectedTms}
            label="Basemap"
            onChange={handleBasemapChange}
            MenuProps={{
              anchorOrigin: {
                vertical: "top",
                horizontal: "center",
              },
              transformOrigin: {
                vertical: "bottom",
                horizontal: "center",
              },
            }}
          >
            {Object.entries(basemapsTmsSources).map(([key, value]) => (
              <MenuItem value={key} key={key}>
                {BasemapsIds[key]}
              </MenuItem>
            ))}
            {/* <MenuItem value={''}>Mapbox</MenuItem> */}
          </Select>
        </FormControl>
        {props.selectedTms == BasemapsIds.PlanetMonthly && (
          <>
            {" "}
            <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="fr">
              <DatePicker
                slotProps={{
                  textField: { size: "small", style: { width: "130px" } },
                }}
                views={["year", "month"]}
                label="Basemap Date"
                format="YYYY/MM"
                minDate={dayjs(validMinDate)}
                maxDate={dayjs(validMaxDate)}
                value={dayjs(props.timelineDate)}
                onChange={(newValue) =>
                  props.setTimelineDate(new Date(newValue))
                }
              />
            </LocalizationProvider>{" "}
          </>
        )}{" "}
        <>
          <ExportSplitButton
            handleClick={handleExportButtonClick}
            setExportInterval={setExportInterval}
          />

          <a
            id="downloadFramesDiv"
            style={{ display: "none" }}
            target="_blank"
            download=""
          />
        </>{" "}
        <SettingsModal
          playbackSpeedFPS={playbackSpeedFPS}
          setPlaybackSpeedFPS={setPlaybackSpeedFPS}
          minDate={minDate}
          setMinDate={setMinDate}
          maxDate={maxDate}
          setMaxDate={setMaxDate}
          exportInterval={exportInterval}
          setExportInterval={setExportInterval}
          // additional settings
          titilerEndpoint={titilerEndpoint}
          setTitilerEndpoint={setTitilerEndpoint}
          maxFrameResolution={maxFrameResolution}
          setMaxFrameResolution={setMaxFrameResolution}
        />
        {props.selectedTms == BasemapsIds.PlanetMonthly && (
          <PlayableSlider
            setTimelineDate={props.setTimelineDate}
            playbackSpeedFPS={playbackSpeedFPS}
            minDate={validMinDate}
            maxDate={validMaxDate}
            //
            min={0}
            max={monthsCount}
            marks={marks}
            //
            value={dateToSliderVal(props.timelineDate, validMinDate)}
            onChange={handleSliderChange}
            valueLabelFormat={(value: any) =>
              valueLabelFormat(value, validMinDate)
            }
          />
        )}
        <LinksSection mapRef={props.mapRef} />
      </div>
    </div>
  );
}

export default ControlPanel;
