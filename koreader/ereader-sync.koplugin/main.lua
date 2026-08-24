local Dispatcher = require("dispatcher")
local InfoMessage = require("ui/widget/infomessage")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local _ = require("gettext")

local EreaderSync = WidgetContainer:extend{
    name = "ereader-sync",
    is_doc_only = false,
}

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

function EreaderSync:onEreaderSyncAll()
    UIManager:show(
        InfoMessage:new{
            text = _(
                "Ereader Sync is loaded.\n\n"
                .. "Sync all will be implemented next."
            ),
        }
    )

    return true
end

function EreaderSync:onEreaderSyncStatus()
    UIManager:show(
        InfoMessage:new{
            text = _(
                "Ereader Sync\n\n"
                .. "Plugin status: loaded\n"
                .. "Books directory: /mnt/us/Books\n"
                .. "Wallpapers directory: /mnt/us/screensaver"
            ),
        }
    )

    return true
end

return EreaderSync