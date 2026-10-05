// Labelled messages for measuring the toolbelt (S32): which tools a message
// should put in front of the Tool Caller. `needs` lists tool-name prefixes
// at least one of which must be offered; an empty list means no tool is
// needed. `family` names the plugin a message is about, if any: every other
// plugin family offered is a leak.
//
// The development set is used to set the thresholds. The held-out set was
// written before any run and is reported once, never tuned on.
export const TOOLBELT_DEVELOPMENT = [
    // No tool: statements, reasoning, conversation, examples.
    { message: "A server went offline at 2:14 AM. There were three administrators: Alice, Ben and Carla. Alice was logged into the admin panel at 2:11 AM.", needs: [] },
    { message: "The restart command completed successfully at 2:13:18. The server remained healthy afterward.", request: "A server went offline at 2:14 AM.", needs: [] },
    { message: "Check the login status of Alice at 2:11 AM", needs: [] },
    { message: "Reconstruct the most likely causal sequence. Separate what is established from what you infer.", needs: [] },
    { message: "A42 → Red\nA55 → Blue", needs: [] },
    { message: "hello Speck my name is Derek I will be your operator", needs: [] },
    { message: "Thanks, that's exactly what I needed.", needs: [] },
    { message: "Why would a virtual disk disappear right after a storage controller was replaced?", needs: [] },
    { message: "What is the difference between a cause and a correlation?", needs: [] },
    { message: "My son's name is Felix and he likes trains.", needs: [] },
    { message: "Write me a short poem about autumn.", needs: [] },
    { message: "Which of the two explanations fits the evidence better?", needs: [] },
    // AirChat.
    { message: "Check the AirChat board", needs: ["airchat_"], family: "airchat" },
    { message: "Are there any tasks waiting for me on AirChat?", needs: ["airchat_"], family: "airchat" },
    { message: "Send a message to the ops channel saying the backup finished", needs: ["airchat_send"], family: "airchat" },
    { message: "Which agents on the fleet can do image generation?", needs: ["airchat_find_agents", "airchat_list_models"], family: "airchat" },
    { message: "Read the shared note called deployment-checklist", needs: ["airchat_read_note", "airchat_list_notes"], family: "airchat" },
    // Social media manager.
    { message: "Draft a LinkedIn post about our new PETG filament", needs: ["social_"], family: "social-media-manager" },
    { message: "Publish the approved post about the filament", needs: ["social_publish_post"], family: "social-media-manager" },
    { message: "How is the social campaign going this week?", needs: ["social_get_report", "social_list_campaign"], family: "social-media-manager" },
    { message: "Someone commented on our Reddit post asking about print speed, log it and suggest a reply", needs: ["social_record_interaction"], family: "social-media-manager" },
    // Information agent.
    { message: "Keep an eye on competitor.example.com and tell me when their prices change", needs: ["info_agent_", "browser_"], family: "information-agent" },
    { message: "Any updates from the sources you're monitoring?", needs: ["info_agent_list_updates"], family: "information-agent" },
    { message: "Start tracking news about resin printer recalls", needs: ["info_agent_save_interest", "info_agent_add_source"], family: "information-agent" },
    // Core tools.
    { message: "create a story and add it to the file call the file file dot text", needs: ["write_file"] },
    { message: "What's in the readme file in my workspace?", needs: ["read_file", "list_files", "document_search"] },
    { message: "Search the web for the latest Qwen release notes", needs: ["browser_search"] },
    { message: "What tasks are in the queue?", needs: ["queue_list"] },
    { message: "Open https://example.com/pricing and tell me what the plans cost", needs: ["browser_read_page"] },
    { message: "Find where the config loader is defined in the source files", needs: ["document_search", "list_files", "read_file"] },
    { message: "Have I told you anything about my printers before?", needs: ["memory_search", "memory_list"] }
];
// The second held-out set, written after the plugins declared their topics
// (2026-10-04) and before any run with them. The first held-out set had been
// run once without topics, so it no longer measures unseen wording.
export const TOOLBELT_HELD_OUT_2 = [
    { message: "The fan on the NAS has been louder since Tuesday.", needs: [] },
    { message: "Carla logged out at 1:50 AM, before any of this started.", request: "A server went offline at 2:14 AM.", needs: [] },
    { message: "So what's your best guess at the cause now?", needs: [] },
    { message: "Hi again, it's Derek.", needs: [] },
    { message: "C7 → Up\nC9 → Down\nC11 → Up", needs: [] },
    { message: "What makes a good apology?", needs: [] },
    { message: "Felix turns eight next month.", needs: [] },
    { message: "Could the timing just be a coincidence?", needs: [] },
    { message: "Let the review agent know the PR is ready for them", needs: ["airchat_send"], family: "airchat" },
    { message: "Is there anything on the board I need to deal with?", needs: ["airchat_check_work", "airchat_check_board", "airchat_check_tasks"], family: "airchat" },
    { message: "Claim the translation task that's open for me", needs: ["airchat_update_task", "airchat_check_tasks"], family: "airchat" },
    { message: "Put together a Product Hunt launch post for the filament dryer", needs: ["social_compose_posts", "social_save_product"], family: "social-media-manager" },
    { message: "Which subreddits would be good for promoting our print farm?", needs: ["social_find_posting_opportunities"], family: "social-media-manager" },
    { message: "How many people engaged with last week's posts?", needs: ["social_get_report", "social_list_campaign"], family: "social-media-manager" },
    { message: "Alert me if the Bambu Lab store changes its shipping page", needs: ["info_agent_add_source", "info_agent_save_interest"], family: "information-agent" },
    { message: "Has anything changed on the pages you're tracking for me?", needs: ["info_agent_list_updates"], family: "information-agent" },
    { message: "Create a file called todo.txt with tomorrow's three jobs", needs: ["write_file"] },
    { message: "Open report.md from my outbox", needs: ["read_file"] },
    { message: "Find recent reviews of the Prusa Core One online", needs: ["browser_search"] },
    { message: "Queue a task to tidy the workspace tonight", needs: ["queue_enqueue"] },
    { message: "What do you remember about my printers?", needs: ["memory_search", "memory_list"] },
    { message: "Search my documents for the warranty terms", needs: ["document_search"] }
];
export const TOOLBELT_HELD_OUT = [
    { message: "The backup job started at midnight and finished at 12:40.", needs: [] },
    { message: "Ben says he didn't touch the hypervisor after 9 PM.", request: "A server went offline at 2:14 AM.", needs: [] },
    { message: "Given all that, which administrator should we talk to first?", needs: [] },
    { message: "Good morning Speck!", needs: [] },
    { message: "B12 → Green\nB15 → Yellow\nB18 → Green", needs: [] },
    { message: "Can you explain what a race condition is, simply?", needs: [] },
    { message: "My wife Hippie is a nurse.", needs: [] },
    { message: "Is it more likely that the disk failed or that someone removed it?", needs: [] },
    { message: "Post a task on AirChat asking someone to review the release notes", needs: ["airchat_post_task"], family: "airchat" },
    { message: "Did anyone mention me on the board today?", needs: ["airchat_check_work", "airchat_search_messages", "airchat_read_messages"], family: "airchat" },
    { message: "Ask the fleet's biggest model to summarise this paragraph", needs: ["airchat_run_model", "airchat_list_models"], family: "airchat" },
    { message: "Save our new 0.2 mm nozzle kit as a product so we can promote it", needs: ["social_save_product"], family: "social-media-manager" },
    { message: "Write three Hacker News post ideas for the nozzle kit", needs: ["social_compose_posts", "social_find_posting_opportunities"], family: "social-media-manager" },
    { message: "Mark the reply to the Reddit commenter as sent", needs: ["social_update_interaction"], family: "social-media-manager" },
    { message: "Watch the Prusa blog for new firmware announcements", needs: ["info_agent_add_source", "info_agent_save_interest"], family: "information-agent" },
    { message: "Run a scan of the monitored sites now", needs: ["info_agent_run_scan"], family: "information-agent" },
    { message: "Save these meeting notes to notes.md in the workspace", needs: ["write_file"] },
    { message: "List the files in my inbox", needs: ["list_files"] },
    { message: "Look up today's weather in Ballarat online", needs: ["browser_search"] },
    { message: "Show me the result of the task you finished yesterday", needs: ["queue_list", "queue_get"] },
    { message: "Remember for later that the shop opens at 9 on Saturdays", needs: ["memory_record"] },
    { message: "Index the workspace documents so you can search them", needs: ["document_index"] }
];
//# sourceMappingURL=toolbelt-cases.js.map