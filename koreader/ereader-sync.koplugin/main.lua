local BookInfoManager = require("bookinfomanager")
local BookList = require("ui/widget/booklist")
local DataStorage = require("datastorage")
local Dispatcher = require("dispatcher")
local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local JSON = require("json")
local LuaSettings = require("luasettings")
local SQ3 = require("lua-ljsqlite3/init")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local lfs = require("libs/libkoreader-lfs")
local logger = require("logger")
local ltn12 = require("ltn12")
local socket = require("socket")
local http = require("socket.http")
local socketutil = require("socketutil")
local _ = require("gettext")

local config = require("config")

local BOOKS_DIR = "/mnt/us/Books"
local WALLPAPERS_DIR = "/mnt/us/screensaver"

local STATS_DB =
    DataStorage:getSettingsDir()
    .. "/statistics.sqlite3"

local SESSION_GAP_SECONDS = 30 * 60
local MIN_COUNTED_SESSION_SECONDS = 3 * 60

local SETTINGS_FILE =
    DataStorage:getSettingsDir()
    .. "/ereader-sync.lua"

local EreaderSync = WidgetContainer:extend{
    name = "ereader-sync",
    is_doc_only = false,

    settings = LuaSettings:open(
        SETTINGS_FILE
    ),

    kosync_instance = nil,
    kosync_original_update_progress = nil,
    kosync_wrapped_update_progress = nil,
}

----------------------------------------------------------------------
-- KINDLE READING STATS
--
-- This is intentionally part of Ereader Sync instead of a separate plugin.
-- A successful *interactive* KOReader Progress Sync push triggers a silent
-- upload of the cumulative statistics snapshot to /stats/kindle.
----------------------------------------------------------------------

local function cleanStatsText(value, fallback)
    if value == nil then
        return fallback or ""
    end

    local result =
        tostring(value)
            :gsub("%z", "")
            :gsub("^%s+", "")
            :gsub("%s+$", "")

    if result == "" then
        return fallback or ""
    end

    return result
end

local function makeStatsBookName(title, author)
    title =
        cleanStatsText(
            title,
            "Unknown title"
        )

    author =
        cleanStatsText(
            author,
            ""
        )

    if author ~= "" then
        return title
            .. " - "
            .. author
            .. ".epub"
    end

    return title
        .. ".epub"
end

local function addStatsDayRecord(
    grouped,
    title,
    author,
    date,
    reading_seconds,
    sessions
)
    if reading_seconds <= 0 then
        return
    end

    local book =
        makeStatsBookName(
            title,
            author
        )

    local key =
        book
        .. "\0"
        .. date

    local record =
        grouped[key]

    if not record then
        record = {
            book = book,
            title =
                cleanStatsText(
                    title,
                    "Unknown title"
                ),
            author =
                cleanStatsText(
                    author,
                    ""
                ),
            date = date,
            reading_seconds = 0,
            sessions = 0,
        }

        grouped[key] =
            record
    end

    record.reading_seconds =
        record.reading_seconds
        + reading_seconds

    record.sessions =
        record.sessions
        + sessions
end

local function finishStatsSession(
    grouped,
    session
)
    if not session then
        return
    end

    local counted =
        session.duration
        >= MIN_COUNTED_SESSION_SECONDS

    addStatsDayRecord(
        grouped,
        session.title,
        session.author,
        session.date,
        session.duration,
        counted and 1 or 0
    )
end

local function buildReadingStatsSnapshot()
    local attributes =
        lfs.attributes(
            STATS_DB
        )

    if not attributes
        or attributes.mode ~= "file"
    then
        return nil,
            "KOReader statistics database not found: "
            .. STATS_DB
    end

    local opened,
        conn_or_error =
        pcall(
            SQ3.open,
            STATS_DB
        )

    if not opened
        or not conn_or_error
    then
        return nil,
            "Could not open statistics.sqlite3: "
            .. tostring(
                conn_or_error
            )
    end

    local conn =
        conn_or_error

    pcall(
        function()
            conn:exec(
                "PRAGMA query_only=ON;"
            )
        end
    )

    local sql = [[
SELECT
    b.title,
    b.authors,
    p.start_time,
    p.duration
FROM page_stat_data AS p
JOIN book AS b
    ON b.id = p.id_book
WHERE
    p.start_time > 0
    AND p.duration > 0
ORDER BY
    b.title,
    b.authors,
    p.start_time;
]]

    local prepared,
        stmt_or_error =
        pcall(
            function()
                return conn:prepare(
                    sql
                )
            end
        )

    if not prepared
        or not stmt_or_error
    then
        conn:close()

        return nil,
            "Could not query KOReader statistics: "
            .. tostring(
                stmt_or_error
            )
    end

    local stmt =
        stmt_or_error

    local grouped = {}
    local current_session = nil

    while true do
        local stepped,
            row =
            pcall(
                function()
                    return stmt:step()
                end
            )

        if not stepped then
            stmt:close()
            conn:close()

            return nil,
                "Could not read KOReader statistics: "
                .. tostring(row)
        end

        if not row then
            break
        end

        local title =
            cleanStatsText(
                row[1],
                "Unknown title"
            )

        local author =
            cleanStatsText(
                row[2],
                ""
            )

        local start_time =
            tonumber(row[3])
            or 0

        local duration =
            math.floor(
                tonumber(row[4])
                or 0
            )

        if start_time > 0
            and duration > 0
        then
            local date =
                os.date(
                    "%Y-%m-%d",
                    start_time
                )

            local same_session =
                current_session
                and current_session.title
                    == title
                and current_session.author
                    == author
                and current_session.date
                    == date
                and start_time
                    <= (
                        current_session.last_end
                        + SESSION_GAP_SECONDS
                    )

            if not same_session then
                finishStatsSession(
                    grouped,
                    current_session
                )

                current_session = {
                    title = title,
                    author = author,
                    date = date,
                    duration = 0,
                    last_end =
                        start_time,
                }
            end

            current_session.duration =
                current_session.duration
                + duration

            local row_end =
                start_time
                + duration

            if row_end
                > current_session.last_end
            then
                current_session.last_end =
                    row_end
            end
        end
    end

    finishStatsSession(
        grouped,
        current_session
    )

    stmt:close()
    conn:close()

    local days = {}

    for _,
        record
        in pairs(grouped)
    do
        table.insert(
            days,
            record
        )
    end

    table.sort(
        days,
        function(a, b)
            if a.date
                ~= b.date
            then
                return a.date
                    < b.date
            end

            return a.book
                < b.book
        end
    )

    return {
        schema_version = 1,
        device = "kindle",
        generated_at =
            os.date(
                "!%Y-%m-%dT%H:%M:%SZ"
            ),
        days = days,
    }, nil
end

local function uploadReadingStatsSnapshot(
    snapshot
)
    local body =
        JSON.encode(
            snapshot
        )

    local sink = {}

    local url =
        config.base_url
        .. "/stats/kindle?token="
        .. config.library_token

    socketutil:set_timeout(
        socketutil.LARGE_BLOCK_TIMEOUT,
        socketutil.LARGE_TOTAL_TIMEOUT
    )

    local code,
        headers,
        status =
        socket.skip(
            1,
            http.request{
                url = url,
                method = "PUT",

                headers = {
                    ["Accept"] =
                        "application/json",
                    ["Accept-Encoding"] =
                        "identity",
                    ["Content-Type"] =
                        "application/json",
                    ["Content-Length"] =
                        tostring(
                            #body
                        ),
                },

                source =
                    ltn12.source.string(
                        body
                    ),

                sink =
                    ltn12.sink.table(
                        sink
                    ),
            }
        )

    socketutil:reset_timeout()

    if headers == nil then
        return false,
            status
            or code
            or "Network unreachable"
    end

    local response_body =
        table.concat(
            sink
        )

    if code ~= 200 then
        return false,
            "HTTP "
            .. tostring(code)
            .. (
                response_body ~= ""
                and (
                    ": "
                    .. response_body
                )
                or ""
            )
    end

    local decoded,
        response =
        pcall(
            JSON.decode,
            response_body,
            JSON.decode.simple
        )

    if not decoded
        or not response
        or response.ok ~= true
    then
        return false,
            "Server rejected statistics snapshot"
    end

    return true, nil
end

function EreaderSync:uploadReadingStatsAfterKOSyncPush()
    local snapshot,
        snapshot_error =
        buildReadingStatsSnapshot()

    if not snapshot then
        logger.warn(
            "EreaderSync:",
            "could not build reading stats snapshot:",
            tostring(
                snapshot_error
            )
        )

        return false
    end

    local uploaded,
        upload_error =
        uploadReadingStatsSnapshot(
            snapshot
        )

    if not uploaded then
        logger.warn(
            "EreaderSync:",
            "could not upload reading stats after KOSync push:",
            tostring(
                upload_error
            )
        )

        return false
    end

    logger.info(
        "EreaderSync:",
        "reading stats uploaded after successful KOSync push;",
        "records:",
        tostring(
            #snapshot.days
        )
    )

    return true
end

function EreaderSync:attachReadingStatsToKOSync()
    local kosync =
        self.ui
        and self.ui.kosync

    if not kosync
        or type(
            kosync.updateProgress
        ) ~= "function"
    then
        logger.warn(
            "EreaderSync:",
            "KOSync instance not available; stats hook not attached"
        )

        return false
    end

    if kosync
        .__ereader_sync_stats_hook
    then
        self.kosync_instance =
            kosync

        return true
    end

    local owner =
        self

    local original_update_progress =
        kosync.updateProgress

    local wrapped_update_progress

    wrapped_update_progress =
        function(
            kosync_self,
            ensure_networking,
            interactive,
            on_suspend
        )
            ----------------------------------------------------------
            -- Only interactive pushes belong to this workflow.
            --
            -- KOReader uses updateProgress(true, true) for the manual
            -- "Push progress from this device now" action. Automatic
            -- background pushes have interactive == false and are left
            -- completely untouched.
            ----------------------------------------------------------

            if interactive ~= true then
                return original_update_progress(
                    kosync_self,
                    ensure_networking,
                    interactive,
                    on_suspend
                )
            end

            ----------------------------------------------------------
            -- KOSyncClient performs its request asynchronously.
            --
            -- Wrap the callback for this invocation only. That lets us
            -- upload statistics *after* KOReader confirms the progress
            -- push succeeded, rather than merely when Wi-Fi connects.
            ----------------------------------------------------------

            local KOSyncClient =
                require(
                    "KOSyncClient"
                )

            local original_client_update =
                KOSyncClient
                    .update_progress

            KOSyncClient.update_progress =
                function(
                    client,
                    username,
                    password,
                    document,
                    metadata,
                    progress,
                    percentage,
                    device,
                    device_id,
                    callback
                )
                    local wrapped_callback =
                        function(
                            ok,
                            status,
                            body
                        )
                            if ok then
                                UIManager:nextTick(
                                    function()
                                        owner:
                                            uploadReadingStatsAfterKOSyncPush()
                                    end
                                )
                            end

                            return callback(
                                ok,
                                status,
                                body
                            )
                        end

                    return original_client_update(
                        client,
                        username,
                        password,
                        document,
                        metadata,
                        progress,
                        percentage,
                        device,
                        device_id,
                        wrapped_callback
                    )
                end

            local called,
                result1,
                result2,
                result3 =
                pcall(
                    original_update_progress,
                    kosync_self,
                    ensure_networking,
                    interactive,
                    on_suspend
                )

            KOSyncClient.update_progress =
                original_client_update

            if not called then
                error(
                    result1
                )
            end

            return result1,
                result2,
                result3
        end

    self.kosync_instance =
        kosync

    self.kosync_original_update_progress =
        original_update_progress

    self.kosync_wrapped_update_progress =
        wrapped_update_progress

    kosync.updateProgress =
        wrapped_update_progress

    kosync
        .__ereader_sync_stats_hook =
        true

    logger.info(
        "EreaderSync:",
        "reading stats hook attached to KOSync"
    )

    return true
end

function EreaderSync:onCloseWidget()
    if self.kosync_instance
        and self
            .kosync_original_update_progress
        and self
            .kosync_wrapped_update_progress
        and self.kosync_instance
            .updateProgress
            == self
                .kosync_wrapped_update_progress
    then
        self.kosync_instance
            .updateProgress =
            self
                .kosync_original_update_progress

        self.kosync_instance
            .__ereader_sync_stats_hook =
            nil
    end

    self.kosync_instance = nil
    self.kosync_original_update_progress = nil
    self.kosync_wrapped_update_progress = nil
end

----------------------------------------------------------------------
-- INITIALIZATION
----------------------------------------------------------------------

function EreaderSync:init()
    self:onDispatcherRegisterActions()
    self.ui.menu:registerToMainMenu(self)

    if self.ui
        and self.ui
            .registerPostReaderReadyCallback
    then
        self.ui:
            registerPostReaderReadyCallback(
                function()
                    self:
                        attachReadingStatsToKOSync()
                end
            )
    end
end

function EreaderSync:onDispatcherRegisterActions()
    Dispatcher:registerAction(
        "ereader_sync_all",
        {
            category = "none",
            event = "EreaderSyncAll",
            title = _("Ereader Sync: Sync all"),
            general = true,
        }
    )

    Dispatcher:registerAction(
        "ereader_sync_status",
        {
            category = "none",
            event = "EreaderSyncStatus",
            title = _("Ereader Sync: Status"),
            general = true,
        }
    )
end

function EreaderSync:addToMainMenu(menu_items)
    menu_items.ereader_sync = {
        text = _("Ereader Sync"),

        sub_item_table = {
            {
                text = _("Sync all"),
                callback = function()
                    self:onEreaderSyncAll()
                end,
            },
            {
                text = _("Status"),
                callback = function()
                    self:onEreaderSyncStatus()
                end,
            },
        },
    }
end

----------------------------------------------------------------------
-- MANIFEST
----------------------------------------------------------------------

function EreaderSync:fetchManifest()
    local sink = {}

    local manifest_url =
        config.base_url
        .. "/manifest?token="
        .. config.library_token

    socketutil:set_timeout(
        socketutil.LARGE_BLOCK_TIMEOUT,
        socketutil.LARGE_TOTAL_TIMEOUT
    )

    local request = {
        url = manifest_url,
        method = "GET",

        headers = {
            ["Accept"] = "application/json",
            ["Accept-Encoding"] = "identity",
        },

        sink = ltn12.sink.table(
            sink
        ),
    }

    local code,
        headers,
        status =
        socket.skip(
            1,
            http.request(
                request
            )
        )

    socketutil:reset_timeout()

    if headers == nil then
        return nil,
            status
            or code
            or "Network unreachable"
    end

    if code ~= 200 then
        return nil,
            "HTTP "
            .. tostring(code)
            .. ": "
            .. tostring(
                status
                or "Request failed"
            )
    end

    local body =
        table.concat(
            sink
        )

    if body == "" then
        return nil,
            "Server returned an empty response"
    end

    local ok,
        manifest =
        pcall(
            JSON.decode,
            body,
            JSON.decode.simple
        )

    if not ok
        or not manifest
    then
        return nil,
            "Could not parse manifest JSON"
    end

    return manifest, nil
end

----------------------------------------------------------------------
-- FILE HELPERS
----------------------------------------------------------------------

function EreaderSync:safeFileName(
    file_name
)
    if not file_name
        or file_name == ""
    then
        return nil
    end

    local safe_name =
        file_name
            :gsub("/", "_")
            :gsub("\\", "_")
            :gsub("%z", "")
            :gsub("^%s+", "")
            :gsub("%s+$", "")

    if safe_name == ""
        or safe_name == "."
        or safe_name == ".."
    then
        return nil
    end

    return safe_name
end

function EreaderSync:fileExists(
    path
)
    local attributes =
        lfs.attributes(
            path
        )

    return attributes ~= nil
        and attributes.mode
            == "file"
end

function EreaderSync:ensureDirectory(
    path
)
    local attributes =
        lfs.attributes(
            path
        )

    if attributes then
        if attributes.mode == "directory" then
            return true, nil
        end

        return false,
            path
            .. " exists but is not a directory"
    end

    local ok,
        err =
        lfs.mkdir(
            path
        )

    if not ok then
        return false,
            tostring(err)
    end

    return true, nil
end

function EreaderSync:countFiles(
    directory,
    pattern
)
    local attributes =
        lfs.attributes(
            directory
        )

    if not attributes
        or attributes.mode ~= "directory"
    then
        return 0
    end

    local count = 0

    for file_name
        in lfs.dir(
            directory
        )
    do
        if file_name
            and file_name ~= "."
            and file_name ~= ".."
            and (
                not pattern
                or file_name:
                    lower():
                    match(pattern)
            )
        then
            count =
                count + 1
        end
    end

    return count
end

----------------------------------------------------------------------
-- VERSION STATE
----------------------------------------------------------------------

function EreaderSync:getRemoteVersion(
    entry
)
    if entry.etag
        and tostring(
            entry.etag
        ) ~= ""
    then
        return tostring(
            entry.etag
        )
    end

    return
        tostring(
            entry.updated or ""
        )
        .. ":"
        .. tostring(
            entry.size or ""
        )
end

function EreaderSync:getStoredBookVersions()
    return self.settings:
        readSetting(
            "book_versions",
            {}
        )
        or {}
end

function EreaderSync:saveBookVersions(
    versions
)
    self.settings:
        saveSetting(
            "book_versions",
            versions
        )

    self.settings:flush()
end

function EreaderSync:getStoredWallpaperVersions()
    return self.settings:
        readSetting(
            "wallpaper_versions",
            {}
        )
        or {}
end

function EreaderSync:saveWallpaperVersions(
    versions
)
    self.settings:
        saveSetting(
            "wallpaper_versions",
            versions
        )

    self.settings:flush()
end

----------------------------------------------------------------------
-- DOWNLOAD
----------------------------------------------------------------------

function EreaderSync:downloadFile(
    url,
    destination
)
    local temporary_path =
        destination
        .. ".part"

    local backup_path =
        destination
        .. ".ereader-backup"

    os.remove(
        temporary_path
    )

    os.remove(
        backup_path
    )

    local file,
        open_error =
        io.open(
            temporary_path,
            "wb"
        )

    if not file then
        return false,
            "Could not create temporary file: "
            .. tostring(
                open_error
            )
    end

    socketutil:set_timeout(
        socketutil.LARGE_BLOCK_TIMEOUT,
        socketutil.LARGE_TOTAL_TIMEOUT
    )

    local code,
        headers,
        status =
        socket.skip(
            1,
            http.request{
                url = url,
                method = "GET",

                headers = {
                    ["Accept-Encoding"] =
                        "identity",
                },

                sink =
                    ltn12.sink.file(
                        file
                    ),
            }
        )

    socketutil:reset_timeout()

    if headers == nil then
        os.remove(
            temporary_path
        )

        return false,
            status
            or code
            or "Network unreachable"
    end

    if code ~= 200 then
        os.remove(
            temporary_path
        )

        return false,
            "HTTP "
            .. tostring(code)
            .. ": "
            .. tostring(
                status
                or "Download failed"
            )
    end

    local attributes =
        lfs.attributes(
            temporary_path
        )

    if not attributes
        or attributes.mode ~= "file"
        or not attributes.size
        or attributes.size <= 0
    then
        os.remove(
            temporary_path
        )

        return false,
            "Downloaded file is empty"
    end

    local destination_existed =
        self:fileExists(
            destination
        )

    if destination_existed then
        local backed_up,
            backup_error =
            os.rename(
                destination,
                backup_path
            )

        if not backed_up then
            os.remove(
                temporary_path
            )

            return false,
                "Could not backup existing file: "
                .. tostring(
                    backup_error
                )
        end
    end

    local renamed,
        rename_error =
        os.rename(
            temporary_path,
            destination
        )

    if not renamed then
        os.remove(
            temporary_path
        )

        if destination_existed then
            os.rename(
                backup_path,
                destination
            )
        end

        return false,
            "Could not save downloaded file: "
            .. tostring(
                rename_error
            )
    end

    if destination_existed then
        os.remove(
            backup_path
        )
    end

    return true, nil
end

----------------------------------------------------------------------
-- KOReader BACKGROUND METADATA JOBS
----------------------------------------------------------------------

function EreaderSync:stopMetadataBackgroundJobs()
    local ok,
        err =
        pcall(
            function()
                --------------------------------------------------
                -- KOReader CoverBrowser extracts metadata and
                -- covers in subprocesses.
                --
                -- An old subprocess may otherwise finish AFTER
                -- we replace an EPUB and write stale metadata
                -- back into bookinfo_cache.sqlite3.
                --------------------------------------------------

                if BookInfoManager
                    .isExtractingInBackground
                    and BookInfoManager:
                        isExtractingInBackground()
                then
                    BookInfoManager:
                        terminateBackgroundJobs()
                end

                --------------------------------------------------
                -- KOReader itself closes this connection before
                -- starting metadata subprocess work.
                --
                -- Closing ours here avoids keeping stale SQLite
                -- state around while files are replaced.
                --------------------------------------------------

                if BookInfoManager
                    .closeDbConnection
                then
                    BookInfoManager:
                        closeDbConnection()
                end
            end
        )

    if not ok then
        return false,
            tostring(err)
    end

    return true, nil
end

----------------------------------------------------------------------
-- KOReader METADATA CACHE
----------------------------------------------------------------------

function EreaderSync:invalidateBookMetadata(
    file
)
    local ok,
        err =
        pcall(
            function()
                BookInfoManager:
                    deleteBookInfo(
                        file
                    )

                BookList
                    .resetBookInfoCache(
                        file
                    )

                UIManager:
                    broadcastEvent(
                        Event:new(
                            "InvalidateMetadataCache",
                            file
                        )
                    )
            end
        )

    if not ok then
        return false,
            tostring(err)
    end

    return true, nil
end

function EreaderSync:invalidateChangedBooks(
    files
)
    if #files == 0 then
        return 0, {}
    end

    local refreshed = 0
    local errors = {}

    --------------------------------------------------------------
    -- FIRST PASS
    --------------------------------------------------------------

    for _, file
        in ipairs(files)
    do
        local ok,
            err =
            self:
                invalidateBookMetadata(
                    file
                )

        if ok then
            refreshed =
                refreshed + 1
        else
            table.insert(
                errors,
                file
                .. ": "
                .. tostring(err)
            )
        end
    end

    UIManager:
        broadcastEvent(
            Event:new(
                "BookMetadataChanged"
            )
        )

    --------------------------------------------------------------
    -- SECOND PASS
    --
    -- A metadata extraction subprocess that was already being
    -- terminated could finish between replacement and the first
    -- DELETE. Delete the affected entries again shortly later.
    --------------------------------------------------------------

    local files_for_second_pass = {}

    for _, file
        in ipairs(files)
    do
        table.insert(
            files_for_second_pass,
            file
        )
    end

    UIManager:scheduleIn(
        1,
        function()
            pcall(
                function()
                    if BookInfoManager
                        .collectSubprocesses
                    then
                        BookInfoManager:
                            collectSubprocesses()
                    end

                    if BookInfoManager
                        .closeDbConnection
                    then
                        BookInfoManager:
                            closeDbConnection()
                    end

                    for _, file
                        in ipairs(
                            files_for_second_pass
                        )
                    do
                        BookInfoManager:
                            deleteBookInfo(
                                file
                            )

                        BookList
                            .resetBookInfoCache(
                                file
                            )

                        UIManager:
                            broadcastEvent(
                                Event:new(
                                    "InvalidateMetadataCache",
                                    file
                                )
                            )
                    end

                    UIManager:
                        broadcastEvent(
                            Event:new(
                                "BookMetadataChanged"
                            )
                        )
                end
            )
        end
    )

    return refreshed,
        errors
end

----------------------------------------------------------------------
-- BOOK SYNC
----------------------------------------------------------------------

function EreaderSync:syncBooks(
    manifest
)
    local result = {
        remote = 0,
        downloaded = 0,
        updated = 0,
        unchanged = 0,
        failed = 0,
        metadata_refreshed = 0,
        metadata_refresh_failed = 0,
        errors = {},
    }

    if not manifest.books then
        return result
    end

    result.remote =
        #manifest.books

    local stopped,
        stop_error =
        self:
            stopMetadataBackgroundJobs()

    if not stopped then
        table.insert(
            result.errors,
            "Could not stop metadata background jobs: "
            .. tostring(
                stop_error
            )
        )
    end

    local versions =
        self:getStoredBookVersions()

    local changed_files = {}

    for _, book
        in ipairs(
            manifest.books
        )
    do
        local file_name =
            self:safeFileName(
                book.name
            )

        if not file_name then
            result.failed =
                result.failed + 1

            table.insert(
                result.errors,
                "Invalid book filename"
            )

        elseif not book.download_url then
            result.failed =
                result.failed + 1

            table.insert(
                result.errors,
                file_name
                .. ": missing download URL"
            )

        else
            local destination =
                BOOKS_DIR
                .. "/"
                .. file_name

            local exists =
                self:fileExists(
                    destination
                )

            local remote_version =
                self:getRemoteVersion(
                    book
                )

            local version_key =
                book.key
                or file_name

            local stored_version =
                versions[
                    version_key
                ]

            local needs_download =
                not exists

            local is_update =
                false

            if exists then
                if not stored_version then
                    needs_download = true
                    is_update = true
                elseif stored_version
                    ~= remote_version
                then
                    needs_download = true
                    is_update = true
                end
            end

            if not needs_download then
                result.unchanged =
                    result.unchanged + 1

            else
                local downloaded,
                    download_error =
                    self:downloadFile(
                        book.download_url,
                        destination
                    )

                if not downloaded then
                    result.failed =
                        result.failed + 1

                    table.insert(
                        result.errors,
                        file_name
                        .. ": "
                        .. tostring(
                            download_error
                        )
                    )

                else
                    versions[
                        version_key
                    ] =
                        remote_version

                    if is_update then
                        result.updated =
                            result.updated + 1
                    else
                        result.downloaded =
                            result.downloaded + 1
                    end

                    table.insert(
                        changed_files,
                        destination
                    )
                end
            end
        end
    end

    self:saveBookVersions(
        versions
    )

    local refreshed,
        refresh_errors =
        self:
            invalidateChangedBooks(
                changed_files
            )

    result.metadata_refreshed =
        refreshed

    result.metadata_refresh_failed =
        #refresh_errors

    for _, err
        in ipairs(
            refresh_errors
        )
    do
        table.insert(
            result.errors,
            err
        )
    end

    return result
end

----------------------------------------------------------------------
-- WALLPAPER SYNC (KINDLE)
----------------------------------------------------------------------

function EreaderSync:syncWallpapers(
    manifest
)
    local result = {
        remote = 0,
        downloaded = 0,
        updated = 0,
        unchanged = 0,
        failed = 0,
        errors = {},
    }

    if not manifest.wallpapers then
        return result
    end

    result.remote =
        #manifest.wallpapers

    local directory_ok,
        directory_error =
        self:ensureDirectory(
            WALLPAPERS_DIR
        )

    if not directory_ok then
        result.failed =
            result.remote

        table.insert(
            result.errors,
            "Could not prepare wallpapers directory: "
            .. tostring(
                directory_error
            )
        )

        return result
    end

    local versions =
        self:getStoredWallpaperVersions()

    for _, wallpaper
        in ipairs(
            manifest.wallpapers
        )
    do
        local file_name =
            self:safeFileName(
                wallpaper.name
            )

        if not file_name then
            result.failed =
                result.failed + 1

            table.insert(
                result.errors,
                "Invalid wallpaper filename"
            )

        elseif not file_name:
            lower():
            match("%.jpe?g$")
        then
            result.failed =
                result.failed + 1

            table.insert(
                result.errors,
                file_name
                .. ": unsupported Kindle wallpaper type"
            )

        elseif not wallpaper.download_url then
            result.failed =
                result.failed + 1

            table.insert(
                result.errors,
                file_name
                .. ": missing download URL"
            )

        else
            local destination =
                WALLPAPERS_DIR
                .. "/"
                .. file_name

            local exists =
                self:fileExists(
                    destination
                )

            local remote_version =
                self:getRemoteVersion(
                    wallpaper
                )

            local version_key =
                wallpaper.key
                or file_name

            local stored_version =
                versions[
                    version_key
                ]

            local needs_download =
                not exists

            local is_update =
                false

            if exists then
                if not stored_version then
                    --------------------------------------------------
                    -- First version-aware wallpaper sync.
                    --
                    -- Download once so the local file definitely
                    -- matches the prepared R2 Kindle wallpaper.
                    --------------------------------------------------

                    needs_download = true
                    is_update = true

                elseif stored_version
                    ~= remote_version
                then
                    needs_download = true
                    is_update = true
                end
            end

            if not needs_download then
                result.unchanged =
                    result.unchanged + 1

            else
                local downloaded,
                    download_error =
                    self:downloadFile(
                        wallpaper.download_url,
                        destination
                    )

                if not downloaded then
                    result.failed =
                        result.failed + 1

                    table.insert(
                        result.errors,
                        file_name
                        .. ": "
                        .. tostring(
                            download_error
                        )
                    )

                else
                    versions[
                        version_key
                    ] =
                        remote_version

                    if is_update then
                        result.updated =
                            result.updated + 1
                    else
                        result.downloaded =
                            result.downloaded + 1
                    end
                end
            end
        end
    end

    self:saveWallpaperVersions(
        versions
    )

    return result
end

----------------------------------------------------------------------
-- SYNC ALL
----------------------------------------------------------------------

function EreaderSync:onEreaderSyncAll()
    local syncing_message =
        InfoMessage:new{
            text =
                "Ereader Sync\n\n"
                .. "Syncing...",
        }

    UIManager:show(
        syncing_message
    )

    UIManager:nextTick(
        function()
            local manifest,
                manifest_error =
                self:fetchManifest()

            UIManager:close(
                syncing_message
            )

            if not manifest then
                UIManager:show(
                    InfoMessage:new{
                        text =
                            "Ereader Sync\n\n"
                            .. "Sync failed.\n\n"
                            .. tostring(
                                manifest_error
                            ),
                    }
                )

                return
            end

            local books =
                self:syncBooks(
                    manifest
                )

            local wallpapers =
                self:syncWallpapers(
                    manifest
                )

            local message =
                "Ereader Sync\n\n"
                .. "Books\n"
                .. "New: "
                .. tostring(
                    books.downloaded
                )
                .. "\n"
                .. "Updated: "
                .. tostring(
                    books.updated
                )
                .. "\n"
                .. "Unchanged: "
                .. tostring(
                    books.unchanged
                )
                .. "\n"
                .. "Failed: "
                .. tostring(
                    books.failed
                )
                .. "\n"
                .. "Metadata refreshed: "
                .. tostring(
                    books
                        .metadata_refreshed
                )

            if books
                .metadata_refresh_failed
                > 0
            then
                message =
                    message
                    .. "\n"
                    .. "Metadata refresh failed: "
                    .. tostring(
                        books
                            .metadata_refresh_failed
                    )
            end

            message =
                message
                .. "\n\n"
                .. "Wallpapers\n"
                .. "New: "
                .. tostring(
                    wallpapers.downloaded
                )
                .. "\n"
                .. "Updated: "
                .. tostring(
                    wallpapers.updated
                )
                .. "\n"
                .. "Unchanged: "
                .. tostring(
                    wallpapers.unchanged
                )
                .. "\n"
                .. "Failed: "
                .. tostring(
                    wallpapers.failed
                )

            local all_errors = {}

            for _, err
                in ipairs(
                    books.errors
                )
            do
                table.insert(
                    all_errors,
                    "Book: "
                    .. err
                )
            end

            for _, err
                in ipairs(
                    wallpapers.errors
                )
            do
                table.insert(
                    all_errors,
                    "Wallpaper: "
                    .. err
                )
            end

            if #all_errors > 0 then
                message =
                    message
                    .. "\n\nWarnings / errors:\n"
                    .. table.concat(
                        all_errors,
                        "\n"
                    )
            end

            UIManager:show(
                InfoMessage:new{
                    text =
                        message,
                }
            )
        end
    )

    return true
end

----------------------------------------------------------------------
-- STATUS
----------------------------------------------------------------------

function EreaderSync:onEreaderSyncStatus()
    local manifest,
        err =
        self:fetchManifest()

    if not manifest then
        UIManager:show(
            InfoMessage:new{
                text =
                    "Ereader Sync\n\n"
                    .. "Connection failed.\n\n"
                    .. tostring(err),
            }
        )

        return true
    end

    local remote_book_count =
        manifest.books
        and #manifest.books
        or 0

    local remote_wallpaper_count =
        manifest.wallpapers
        and #manifest.wallpapers
        or 0

    local local_book_count =
        self:countFiles(
            BOOKS_DIR,
            "%.epub$"
        )

    local local_wallpaper_count =
        self:countFiles(
            WALLPAPERS_DIR,
            "%.jpe?g$"
        )

    local book_versions =
        self:getStoredBookVersions()

    local wallpaper_versions =
        self:getStoredWallpaperVersions()

    local tracked_book_count = 0
    local tracked_wallpaper_count = 0

    for _ in pairs(
        book_versions
    ) do
        tracked_book_count =
            tracked_book_count + 1
    end

    for _ in pairs(
        wallpaper_versions
    ) do
        tracked_wallpaper_count =
            tracked_wallpaper_count + 1
    end

    UIManager:show(
        InfoMessage:new{
            text =
                "Ereader Sync\n\n"
                .. "Server: connected\n\n"
                .. "Books\n"
                .. "Remote: "
                .. tostring(
                    remote_book_count
                )
                .. "\n"
                .. "Local: "
                .. tostring(
                    local_book_count
                )
                .. "\n"
                .. "Version tracked: "
                .. tostring(
                    tracked_book_count
                )
                .. "\n\n"
                .. "Wallpapers\n"
                .. "Remote: "
                .. tostring(
                    remote_wallpaper_count
                )
                .. "\n"
                .. "Local: "
                .. tostring(
                    local_wallpaper_count
                )
                .. "\n"
                .. "Version tracked: "
                .. tostring(
                    tracked_wallpaper_count
                )
                .. "\n\n"
                .. "Books: "
                .. BOOKS_DIR
                .. "\n"
                .. "Wallpapers: "
                .. WALLPAPERS_DIR,
        }
    )

    return true
end

return EreaderSync
