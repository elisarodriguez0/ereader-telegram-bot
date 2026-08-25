local BookInfoManager = require("bookinfomanager")
local BookList = require("ui/widget/booklist")
local DataStorage = require("datastorage")
local Dispatcher = require("dispatcher")
local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local JSON = require("json")
local LuaSettings = require("luasettings")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local lfs = require("libs/libkoreader-lfs")
local ltn12 = require("ltn12")
local socket = require("socket")
local http = require("socket.http")
local socketutil = require("socketutil")
local _ = require("gettext")

local config = require("config")

local BOOKS_DIR = "/mnt/us/Books"
local WALLPAPERS_DIR = "/mnt/us/screensaver"

local SETTINGS_FILE =
    DataStorage:getSettingsDir()
    .. "/ereader-sync.lua"

local EreaderSync = WidgetContainer:extend{
    name = "ereader-sync",
    is_doc_only = false,

    settings = LuaSettings:open(
        SETTINGS_FILE
    ),
}

----------------------------------------------------------------------
-- INITIALIZATION
----------------------------------------------------------------------

function EreaderSync:init()
    self:onDispatcherRegisterActions()
    self.ui.menu:registerToMainMenu(self)
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
            ["Accept"] =
                "application/json",

            ["Accept-Encoding"] =
                "identity",
        },

        sink =
            ltn12.sink.table(
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

----------------------------------------------------------------------
-- VERSION STATE
----------------------------------------------------------------------

function EreaderSync:getRemoteVersion(
    book
)
    if book.etag
        and tostring(
            book.etag
        ) ~= ""
    then
        return tostring(
            book.etag
        )
    end

    return
        tostring(
            book.updated or ""
        )
        .. ":"
        .. tostring(
            book.size or ""
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
        or attributes.mode
            ~= "file"
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

                --------------------------------------------------
                -- Persistent metadata/cover cache.
                --------------------------------------------------

                BookInfoManager:
                    deleteBookInfo(
                        file
                    )

                --------------------------------------------------
                -- Generic in-memory BookList cache.
                --------------------------------------------------

                BookList
                    .resetBookInfoCache(
                        file
                    )

                --------------------------------------------------
                -- Notify all active metadata-aware components.
                --------------------------------------------------

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
    --
    -- Immediately after the new EPUBs have reached their final
    -- path.
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
    -- terminated could theoretically finish between replacement
    -- and the first DELETE.
    --
    -- Delete the affected entries again shortly afterwards.
    --
    -- This does not depend on any particular library UI.
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

    --------------------------------------------------------------
    -- IMPORTANT:
    -- stop old CoverBrowser extraction jobs BEFORE replacing
    -- any EPUB.
    --------------------------------------------------------------

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

    for _,
        book
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
                result.failed
                + 1

            table.insert(
                result.errors,
                "Invalid filename"
            )

        elseif not book.download_url then
            result.failed =
                result.failed
                + 1

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
                    needs_download =
                        true

                    is_update =
                        true

                elseif stored_version
                    ~= remote_version
                then
                    needs_download =
                        true

                    is_update =
                        true
                end
            end

            if not needs_download then
                result.unchanged =
                    result.unchanged
                    + 1

            else
                local downloaded,
                    download_error =
                    self:downloadFile(
                        book.download_url,
                        destination
                    )

                if not downloaded then
                    result.failed =
                        result.failed
                        + 1

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
                            result.updated
                            + 1

                    else
                        result.downloaded =
                            result.downloaded
                            + 1
                    end

                    --------------------------------------------------
                    -- Do NOT invalidate immediately here.
                    --
                    -- Finish replacing all books first, then clear
                    -- metadata in one controlled pass.
                    --------------------------------------------------

                    table.insert(
                        changed_files,
                        destination
                    )
                end
            end
        end
    end

    --------------------------------------------------------------
    -- Persist versions only for successful downloads.
    --------------------------------------------------------------

    self:saveBookVersions(
        versions
    )

    --------------------------------------------------------------
    -- Now that every EPUB is safely in place, invalidate metadata.
    --------------------------------------------------------------

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

            if #books.errors > 0 then
                message =
                    message
                    .. "\n\nWarnings / errors:\n"
                    .. table.concat(
                        books.errors,
                        "\n"
                    )
            end

            message =
                message
                .. "\n\n"
                .. "Wallpapers: not synced yet"

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
        0

    for file_name
        in lfs.dir(
            BOOKS_DIR
        )
    do
        if file_name
            and file_name:
                lower():
                match("%.epub$")
        then
            local_book_count =
                local_book_count
                + 1
        end
    end

    local versions =
        self:getStoredBookVersions()

    local tracked_count =
        0

    for _ in pairs(
        versions
    ) do
        tracked_count =
            tracked_count
            + 1
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
                    tracked_count
                )
                .. "\n\n"
                .. "Remote wallpapers: "
                .. tostring(
                    remote_wallpaper_count
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