const tmi = require("tmi.js");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const twitchChannel = "nymn"; // Change to your channel

// Game state
let gameState = {
  phase: "idle", // idle, applications, selection, voting, results, map
  candidates: [],
  selectedCandidates: [],
  votes: {},
  teams: [],
  rebels: {
    leaders: [],
    members: []
  },
  teamsData: [],
  rebelsData: null,
  timerEndTime: 0,
  mapGenerated: false,
  claimedTiles: {}
};

// Twitch chat configuration
const client = new tmi.Client({
  connection: { reconnect: true },
  channels: [twitchChannel],
});

// When a message is received in Twitch chat, process it
client.on("message", (channel, tags, message, self) => {
  if (!self) {
    const username = tags["display-name"];
    
    // Send the raw message to the frontend
    io.emit("chatMessage", { user: username, message });
    
    // Process game commands
    if (gameState.phase === "applications" && message.startsWith("!run ")) {
      console.log(`Processing application command from ${username}: ${message}`);
      processApplicationCommand(username, message);
    } 
    else if (gameState.phase === "voting" && message.startsWith("!vote ")) {
      console.log(`Processing vote command from ${username}: ${message}`);
      processVoteCommand(username, message);
    }
    else if (gameState.phase === "map" && message.startsWith("!claim ")) {
      console.log(`Processing claim command from ${username}: ${message}`);
      processClaimCommand(username, message);
    }
    else if (message.startsWith("!")) {
      console.log(`Received command but not processed: ${username}: ${message} (current phase: ${gameState.phase})`);
    }
  }
});

// Process !run command for applications
function processApplicationCommand(username, message) {
  // Extract team name and slogan from message format: !run <Team Name> <Team Slogan/Motto>
  const parts = message.split(" ");
  
  // Ensure the command has at least 3 parts (command, team name, slogan)
  if (parts.length >= 3) {
    const teamName = parts[1];
    const teamSlogan = parts.slice(2).join(" ");
    
    // Validate team name
    if (!teamName || teamName.trim() === "") {
      // Team name is required
      return;
    }
    
    // Check if user already applied
    const existingCandidate = gameState.candidates.find(c => c.username === username);
    
    // Check if team name is already taken by someone else
    const teamNameTaken = gameState.candidates.some(c => 
      c.username !== username && 
      c.teamName.toLowerCase() === teamName.toLowerCase()
    );
    
    if (teamNameTaken) {
      // Team name is already taken, don't update or add this application
      // Optionally, you could notify the user that the team name is taken
      return;
    }
    
    if (existingCandidate) {
      // Update the existing application
      existingCandidate.teamName = teamName;
      existingCandidate.teamSlogan = teamSlogan;
      existingCandidate.timestamp = Date.now(); // Update timestamp
    } else {
      // Add new application
      gameState.candidates.push({
        username,
        teamName,
        teamSlogan,
        timestamp: Date.now()
      });
    }
    
    // Emit updated candidates list
    io.emit("updateCandidates", gameState.candidates);
  }
}

// Process !vote command during voting phase
function processVoteCommand(username, message) {
  // Extract vote from message format: !vote <Candidate Username or Number>
  const parts = message.split(" ");
  
  if (parts.length >= 2) {
    // Check if the user is a team leader (can't vote)
    const isTeamLeader = gameState.selectedCandidates.some(c => 
      c.username.toLowerCase() === username.toLowerCase()
    );
    
    if (isTeamLeader) {
      // Team leaders can't vote
      return;
    }
    
    const voteInput = parts[1];
    let voteFor = voteInput;
    
    // Check if the vote is a number
    if (!isNaN(voteInput) && voteInput > 0 && voteInput <= gameState.selectedCandidates.length) {
      // Convert the number to the corresponding candidate's username
      const candidateIndex = parseInt(voteInput) - 1;
      voteFor = gameState.selectedCandidates[candidateIndex].username;
    }
    
    // Check if the voted for candidate exists in our selected candidates
    const candidateExists = gameState.selectedCandidates.some(c => 
      c.username.toLowerCase() === voteFor.toLowerCase()
    );
    
    if (candidateExists) {
      // Record the vote
      gameState.votes[username] = voteFor.toLowerCase();
      
      // Emit updated votes
      io.emit("updateVotes", gameState.votes);
    }
  }
}

// Process claim command for map tiles
function processClaimCommand(username, message) {
  console.log(`Processing claim command from ${username}: ${message}`);
  
  try {
    // Only process during map phase
    if (gameState.phase !== "map") {
      console.log("Not in map phase, ignoring claim");
      return;
    }
    
    // Check if the map exists
    if (!gameState.map || !gameState.map.grid) {
      console.log("Map not initialized, ignoring claim");
      return;
    }
    
    // Check if the user is a team leader
    const team = gameState.teamsData.find(team => 
      team.leader.toLowerCase() === username.toLowerCase());
    
    if (!team) {
      console.log(`${username} is not a team leader, ignoring claim`);
      return;
    }
    
    // Check if it's this team's turn to pick
    if (gameState.map.currentTeamPicking !== team.leader) {
      console.log(`Not ${username}'s turn to pick, current picker is ${gameState.map.currentTeamPicking}`);
      return;
    }
    
    // Parse the command: !claim A1 (where A is column, 1 is row)
    // This matches formats like !claim A1, !claim a1, !claim A 1, etc.
    const match = message.match(/!claim\s+([a-fA-F])[\s-]*([1-6])/i);
    
    if (!match) {
      console.log(`Invalid claim format: ${message}`);
      return;
    }
    
    // Convert A-F to 0-5 for column
    const colLetter = match[1].toUpperCase();
    const col = colLetter.charCodeAt(0) - 'A'.charCodeAt(0);
    
    // Convert 1-6 to 0-5 for row
    const row = parseInt(match[2]) - 1;
    
    console.log(`Parsed coordinates: row=${row}, col=${col}`);
    
    // Check if the coordinates are valid
    if (row < 0 || row >= gameState.map.size || col < 0 || col >= gameState.map.size) {
      console.log(`Invalid coordinates: row=${row}, col=${col}`);
      return;
    }
    
    // Try to claim the cell
    if (claimCell(row, col, team)) {
      console.log(`${username} successfully claimed cell at ${colLetter}${row+1}`);
      // If successful, move to the next team
      moveToNextTeam();
    } else {
      console.log(`${username} failed to claim cell at ${colLetter}${row+1}`);
    }
  } catch (error) {
    console.error(`Error in processClaimCommand: ${error.message}`);
    console.error(error.stack);
  }
}

// Start listening to Twitch chat
client.connect();

// Socket.io connection handling
io.on("connection", (socket) => {
    console.log("New client connected");
    
    // Send current game state to the new client
    socket.emit("gameState", gameState);
    
    // Handle admin commands
    socket.on("startApplications", () => {
        console.log("Starting applications phase");
        startApplicationsPhase();
    });
    
    socket.on("startElection", () => {
        console.log("Starting voting phase");
        startVotingPhase();
    });
    
    socket.on("generateMap", () => {
        console.log("Generating map");
        generateMap();
    });
    
    socket.on("resetGame", () => {
        console.log("Resetting game");
        resetGame();
    });
    
    socket.on("createDummyTeams", () => {
        console.log("Creating dummy teams");
        createDummyTeams();
    });
    
    // Handle disconnection
    socket.on("disconnect", () => {
        console.log("Client disconnected");
    });
    
    // Handle errors
    socket.on("error", (error) => {
        console.error("Socket error:", error);
    });
});

// Error handling for the server
server.on("error", (error) => {
    console.error("Server error:", error);
});

// End applications phase and select random candidates
function endApplicationsPhase() {
  gameState.phase = "selection";
  
  // Select 12 random candidates instead of 10
  const shuffled = [...gameState.candidates].sort(() => 0.5 - Math.random());
  gameState.selectedCandidates = shuffled.slice(0, Math.min(12, shuffled.length));
  
  io.emit("gameState", gameState);
}

// Generate a random color from a set of distinct colors
function generateTeamColor(teamIndex = -1) {
    // Distinct colors for teams
    const teamColors = [
        '#e74c3c', // Red
        '#3498db', // Blue
        '#2ecc71', // Green
        '#f1c40f', // Yellow
        '#9b59b6', // Purple
        '#1abc9c', // Turquoise
        '#e67e22', // Orange
        '#34495e', // Navy
        '#d35400', // Dark Orange
        '#27ae60', // Emerald
        '#8e44ad', // Violet
        '#16a085', // Green Sea
        '#f39c12', // Sun Flower
        '#2980b9', // Belize Hole
        '#c0392b'  // Pomegranate
    ];
    
    // Special color for rebels
    if (teamIndex === -1) {
        return '#8B3A3A'; // Dark red for rebels
    }
    
    // Return a color based on team index, or random if index is out of bounds
    if (teamIndex >= 0 && teamIndex < teamColors.length) {
        return teamColors[teamIndex];
    } else {
        return teamColors[Math.floor(Math.random() * teamColors.length)];
    }
}

// Save team data with additional information
function saveTeamData() {
    // Create enhanced team data with colors and stats
    gameState.teamsData = gameState.teams.map((team, index) => ({
        teamName: team.teamName,
        leader: team.leader,
        teamSlogan: team.teamSlogan,
        members: [team.leader, ...team.members],
        color: generateTeamColor(index), // Pass index to get unique color
        score: 0,
        wins: 0,
        resources: {
            wood: 0,
            iron: 0,
            clay: 0
        }
    }));
    
    // Create rebels data if there are any
    if (gameState.rebels && (gameState.rebels.leaders.length > 0 || gameState.rebels.members.length > 0)) {
        gameState.rebelsData = {
            teamName: "The Rebels",
            members: gameState.rebels.members,
            leaders: gameState.rebels.leaders,
            color: generateTeamColor(-1), // Special color for rebels
            score: 0,
            wins: 0,
            resources: {
                wood: 0,
                iron: 0,
                clay: 0
            }
        };
    } else {
        gameState.rebelsData = null;
    }
}

// End voting phase and form teams
function endVotingPhase() {
  gameState.phase = "results";
  
  // Count votes for each candidate
  const voteCounts = {};
  gameState.selectedCandidates.forEach(candidate => {
    voteCounts[candidate.username.toLowerCase()] = 0;
  });
  
  Object.values(gameState.votes).forEach(vote => {
    voteCounts[vote] = (voteCounts[vote] || 0) + 1;
  });
  
  // Sort candidates by votes
  const sortedCandidates = [...gameState.selectedCandidates]
    .map(candidate => ({
      ...candidate,
      voteCount: voteCounts[candidate.username.toLowerCase()] || 0
    }))
    .sort((a, b) => b.voteCount - a.voteCount);
  
  // Top 5 candidates become team leaders
  const teamLeaders = sortedCandidates.slice(0, Math.min(5, sortedCandidates.length));
  const rejectedLeaders = sortedCandidates.slice(Math.min(5, sortedCandidates.length));
  
  // Get all team leader usernames (lowercase for comparison)
  const allLeaderUsernames = gameState.selectedCandidates.map(c => c.username.toLowerCase());
  
  // Form teams
  gameState.teams = teamLeaders.map(leader => {
    // Find all users who voted for this leader (excluding other team leaders)
    const teamMembers = Object.entries(gameState.votes)
      .filter(([voter, vote]) => {
        // Check if this vote is for this leader
        const isVoteForThisLeader = vote.toLowerCase() === leader.username.toLowerCase();
        
        // Check if voter is not a team leader
        const isVoterNotLeader = !allLeaderUsernames.includes(voter.toLowerCase());
        
        return isVoteForThisLeader && isVoterNotLeader;
      })
      .map(([voter]) => voter);
    
    return {
      leader: leader.username,
      teamName: leader.teamName,
      teamSlogan: leader.teamSlogan,
      members: teamMembers
    };
  });
  
  // Form rebels team from rejected leaders and their voters
  gameState.rebels.leaders = rejectedLeaders.map(leader => leader.username);
  
  // Add all voters for rejected candidates to rebels (excluding team leaders)
  const rebelVoters = Object.entries(gameState.votes)
    .filter(([voter, vote]) => {
      // Check if vote is for a rejected leader
      const isVoteForRejectedLeader = rejectedLeaders.some(leader => 
        leader.username.toLowerCase() === vote.toLowerCase()
      );
      
      // Check if voter is not a team leader
      const isVoterNotLeader = !allLeaderUsernames.includes(voter.toLowerCase());
      
      return isVoteForRejectedLeader && isVoterNotLeader;
    })
    .map(([voter]) => voter);
  
  gameState.rebels.members = rebelVoters;
  
  // Save enhanced team data with colors
  saveTeamData();
  
  io.emit("gameState", gameState);
}

// Generate the map
function generateMap() {
  try {
    console.log("Generating game map...");
    
    // Check if teamsData exists
    if (!gameState.teamsData || gameState.teamsData.length === 0) {
      console.error("No teams data available, cannot generate map");
      return;
    }
    
    // Set game phase to map
    gameState.phase = "map";
    
    // Create a 6x6 grid
    gameState.map = {
        size: 6,
        grid: [],
        currentTeamPicking: null,
        pickingOrder: [],
        pickingTimeEnd: 0
    };
    
    // Terrain types
    const terrainTypes = ["water", "land", "mountain", "desert"];
    
    // Resource types
    const resourceTypes = ["wood", "iron", "clay"];
    
    // Generate the grid with random terrain
    for (let row = 0; row < gameState.map.size; row++) {
        gameState.map.grid[row] = [];
        for (let col = 0; col < gameState.map.size; col++) {
            // Random terrain (weighted to have more land)
            const terrainRoll = Math.random();
            let terrain;
            if (terrainRoll < 0.2) {
                terrain = "water";
            } else if (terrainRoll < 0.6) {
                terrain = "land";
            } else if (terrainRoll < 0.8) {
                terrain = "mountain";
            } else {
                terrain = "desert";
            }
            
            gameState.map.grid[row][col] = {
                row,
                col,
                terrain,
                resource: null,
                owner: null
            };
        }
    }
    
    // Place 10 resources randomly on the map (avoiding water)
    let resourcesPlaced = 0;
    let maxAttempts = 100; // Prevent infinite loop
    let attempts = 0;
    
    while (resourcesPlaced < 10 && attempts < maxAttempts) {
        attempts++;
        const row = Math.floor(Math.random() * gameState.map.size);
        const col = Math.floor(Math.random() * gameState.map.size);
        const cell = gameState.map.grid[row][col];
        
        // Only place resources on non-water cells that don't already have a resource
        if (cell.terrain !== "water" && cell.resource === null) {
            // Randomly select a resource type
            const resourceType = resourceTypes[Math.floor(Math.random() * resourceTypes.length)];
            cell.resource = resourceType;
            resourcesPlaced++;
        }
    }
    
    // Determine picking order based on team size (smallest first)
    gameState.map.pickingOrder = [...gameState.teamsData]
        .sort((a, b) => a.members.length - b.members.length)
        .map(team => team.leader);
    
    console.log("Team picking order:", gameState.map.pickingOrder);
    
    // Set the current team picking
    if (gameState.map.pickingOrder.length > 0) {
      gameState.map.currentTeamPicking = gameState.map.pickingOrder[0];
      
      // Set timer for 15 seconds
      gameState.map.pickingTimeEnd = Date.now() + 15000;
      
      // Set map as generated
      gameState.mapGenerated = true;
      
      // Clear any previous claimed tiles
      gameState.claimedTiles = {};
      
      // Emit map generated event
      io.emit("mapGenerated", gameState.map);
      io.emit("gameState", gameState);
      
      // Find the team that's currently picking
      const pickingTeam = gameState.teamsData.find(team => 
          team.leader === gameState.map.currentTeamPicking);
      
      // Emit the picking update
      io.emit("pickingUpdate", {
          currentTeamPicking: gameState.map.currentTeamPicking,
          pickingTeamName: pickingTeam ? pickingTeam.teamName : "Unknown Team",
          pickingTimeEnd: gameState.map.pickingTimeEnd
      });
      
      console.log(`First team to pick: ${pickingTeam ? pickingTeam.teamName : "Unknown"} (${gameState.map.currentTeamPicking})`);
      
      // Start the timer for the first team to pick
      startPickingTimer();
    } else {
      console.error("No teams available for picking order");
    }
  } catch (error) {
    console.error(`Error in generateMap: ${error.message}`);
    console.error(error.stack);
  }
}

// Function to handle the picking timer
function startPickingTimer() {
  try {
    // Check if map exists
    if (!gameState.map || !gameState.map.currentTeamPicking) {
      console.log("Map not initialized or no current team picking, cannot start timer");
      return;
    }
    
    // Clear any existing timer
    if (gameState.pickingTimerId) {
      clearTimeout(gameState.pickingTimerId);
    }
    
    console.log(`Starting 15-second timer for team ${gameState.map.currentTeamPicking}`);
    
    // Set a timeout for 15 seconds
    gameState.pickingTimerId = setTimeout(() => {
      // If time runs out, assign a random valid starting position
      assignRandomStartingPosition();
    }, 15000);
  } catch (error) {
    console.error(`Error in startPickingTimer: ${error.message}`);
    console.error(error.stack);
  }
}

// Function to assign a random starting position if time runs out
function assignRandomStartingPosition() {
  try {
    if (!gameState.map || !gameState.map.currentTeamPicking) {
      console.log("No current team picking, cannot assign random position");
      return;
    }
    
    // Get the current team
    const currentTeam = gameState.teamsData.find(team => 
      team.leader === gameState.map.currentTeamPicking);
    
    if (!currentTeam) {
      console.log("Could not find current team data");
      return;
    }
    
    console.log(`Time ran out for ${currentTeam.leader}, assigning random position`);
    
    // Find all valid cells (not water and not claimed)
    const validCells = [];
    for (let row = 0; row < gameState.map.size; row++) {
      for (let col = 0; col < gameState.map.size; col++) {
        const cell = gameState.map.grid[row][col];
        if (cell && cell.terrain !== "water" && !cell.owner) {
          validCells.push({row, col, cell});
        }
      }
    }
    
    // If there are valid cells, pick one randomly
    if (validCells.length > 0) {
      const randomIndex = Math.floor(Math.random() * validCells.length);
      const randomCell = validCells[randomIndex];
      
      // Convert to A1 format for logging
      const colLetter = String.fromCharCode('A'.charCodeAt(0) + randomCell.col);
      const rowNumber = randomCell.row + 1;
      
      console.log(`Randomly selected cell at ${colLetter}${rowNumber} for ${currentTeam.leader}`);
      claimCell(randomCell.row, randomCell.col, currentTeam);
    } else {
      console.log("No valid cells available for random assignment");
    }
    
    // Move to the next team
    moveToNextTeam();
  } catch (error) {
    console.error(`Error in assignRandomStartingPosition: ${error.message}`);
    console.error(error.stack);
    
    // Try to recover by moving to the next team
    try {
      moveToNextTeam();
    } catch (e) {
      console.error(`Failed to recover by moving to next team: ${e.message}`);
    }
  }
}

// Function to claim a cell for a team
function claimCell(row, col, team) {
  try {
    // Check if map exists
    if (!gameState.map || !gameState.map.grid) {
      console.log("Map not initialized, cannot claim cell");
      return false;
    }
    
    // Make sure the cell exists and is not water or already claimed
    if (!gameState.map.grid[row] || !gameState.map.grid[row][col]) {
      console.log(`Cell at ${row},${col} does not exist`);
      
      // Convert coordinates to A1 format for error message
      const colLetter = String.fromCharCode('A'.charCodeAt(0) + col);
      const rowNumber = row + 1;
      
      // Send error message to client
      io.emit("claimError", {
        message: `Invalid coordinates: ${colLetter}${rowNumber}`,
        leader: team.leader
      });
      
      return false;
    }
    
    const cell = gameState.map.grid[row][col];
    
    if (cell.terrain === "water") {
      console.log(`Cell at ${row},${col} is water and cannot be claimed`);
      
      // Convert coordinates to A1 format for error message
      const colLetter = String.fromCharCode('A'.charCodeAt(0) + col);
      const rowNumber = row + 1;
      
      // Send error message to client
      io.emit("claimError", {
        message: `${colLetter}${rowNumber} is water and cannot be claimed. Please pick a different tile.`,
        leader: team.leader
      });
      
      return false;
    }
    
    if (cell.owner) {
      console.log(`Cell at ${row},${col} is already claimed by ${cell.owner}`);
      
      // Convert coordinates to A1 format for error message
      const colLetter = String.fromCharCode('A'.charCodeAt(0) + col);
      const rowNumber = row + 1;
      
      // Find the team that owns this cell
      const ownerTeam = gameState.teamsData.find(t => t.leader === cell.owner);
      const ownerTeamName = ownerTeam ? ownerTeam.teamName : "another team";
      
      // Send error message to client
      io.emit("claimError", {
        message: `${colLetter}${rowNumber} is already claimed by ${ownerTeamName}. Please pick a different tile.`,
        leader: team.leader
      });
      
      return false;
    }
    
    // Claim the cell
    cell.owner = team.leader;
    
    // Convert coordinates to A1 format for logging
    const colLetter = String.fromCharCode('A'.charCodeAt(0) + col);
    const rowNumber = row + 1;
    console.log(`Cell at ${colLetter}${rowNumber} claimed by ${team.leader} (${team.teamName})`);
    
    // Emit the updated map
    io.emit("cellClaimed", {
      row,
      col,
      owner: team.leader,
      teamName: team.teamName,
      color: team.color
    });
    
    // Send success message
    io.emit("claimSuccess", {
      message: `${team.leader} has claimed ${colLetter}${rowNumber} for ${team.teamName}!`,
      leader: team.leader,
      teamName: team.teamName,
      coordinates: `${colLetter}${rowNumber}`
    });
    
    return true;
  } catch (error) {
    console.error(`Error in claimCell: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

// Function to move to the next team in the picking order
function moveToNextTeam() {
  try {
    // Check if map exists
    if (!gameState.map || !gameState.map.pickingOrder) {
      console.log("Map not initialized or picking order missing, cannot move to next team");
      return;
    }
    
    // Remove the current team from the picking order
    const currentIndex = gameState.map.pickingOrder.indexOf(gameState.map.currentTeamPicking);
    if (currentIndex !== -1) {
      gameState.map.pickingOrder.splice(currentIndex, 1);
    }
    
    // If there are more teams to pick, set the next one
    if (gameState.map.pickingOrder.length > 0) {
      gameState.map.currentTeamPicking = gameState.map.pickingOrder[0];
      gameState.map.pickingTimeEnd = Date.now() + 15000;
      
      // Find the team that's currently picking
      const pickingTeam = gameState.teamsData.find(team => 
        team.leader === gameState.map.currentTeamPicking);
      
      console.log(`Moving to next team: ${pickingTeam ? pickingTeam.teamName : "Unknown"} (${gameState.map.currentTeamPicking})`);
      
      // Emit the updated picking state
      io.emit("pickingUpdate", {
        currentTeamPicking: gameState.map.currentTeamPicking,
        pickingTeamName: pickingTeam ? pickingTeam.teamName : "Unknown Team",
        pickingTimeEnd: gameState.map.pickingTimeEnd
      });
      
      // Start the timer for the next team
      startPickingTimer();
    } else {
      // All teams have picked, move to the next phase
      console.log("All teams have picked, completing the map phase");
      gameState.map.currentTeamPicking = null;
      io.emit("pickingComplete");
    }
    
    // Update game state
    io.emit("gameState", gameState);
  } catch (error) {
    console.error(`Error in moveToNextTeam: ${error.message}`);
    console.error(error.stack);
  }
}

// Reset the game
function resetGame() {
  console.log("Resetting game...");
  
  // Reset game state
  gameState = {
    phase: "idle",
    candidates: [],
    selectedCandidates: [],
    votes: {},
    teams: [],
    rebels: {
      leaders: [],
      members: []
    },
    timerEndTime: 0,
    mapGenerated: false,
    claimedTiles: {},
    map: null,
    teamsData: null,
    rebelsData: null
  };
  
  // Clear any active timers
  if (gameState.pickingTimerId) {
    clearTimeout(gameState.pickingTimerId);
    gameState.pickingTimerId = null;
  }
  
  // Notify clients
  io.emit("gameReset");
}

// Start applications phase
function startApplicationsPhase() {
  // Reset game state for a new round
  gameState = {
    phase: "applications",
    candidates: [],
    selectedCandidates: [],
    votes: {},
    teams: [],
    rebels: {
      leaders: [],
      members: []
    },
    teamsData: [],
    rebelsData: null,
    timerEndTime: Date.now() + 30000, // 30 seconds
    mapGenerated: false,
    claimedTiles: {}
  };
  
  io.emit("gameState", gameState);
  
  // End applications after 30 seconds
  setTimeout(() => {
    endApplicationsPhase();
  }, 30000);
}

// Start voting phase
function startVotingPhase() {
  // Start the voting phase
  gameState.phase = "voting";
  gameState.timerEndTime = Date.now() + 30000; // 30 seconds
  
  io.emit("gameState", gameState);
  
  // End voting after 30 seconds
  setTimeout(() => {
    endVotingPhase();
  }, 30000);
}

// Create dummy teams for testing
function createDummyTeams() {
  // Set game state to results phase
  gameState.phase = "results";
  
  // Create dummy teams with specified leaders
  gameState.teams = [
    {
      leader: "Andylicious96",
      teamName: "The Wolves",
      teamSlogan: "We hunt as a pack!",
      members: ["Andylicious96", "user1", "user2", "user3"]
    },
    {
      leader: "davekorbiger",
      teamName: "Desert Scorpions",
      teamSlogan: "Strike fast, strike hard!",
      members: ["davekorbiger", "user4", "user5", "user6", "user7"]
    },
    {
      leader: "rboq",
      teamName: "Mountain Giants",
      teamSlogan: "Unbreakable as stone!",
      members: ["rboq", "user8", "user9"]
    },
    {
      leader: "mangooderso",
      teamName: "Forest Spirits",
      teamSlogan: "One with nature!",
      members: ["mangooderso", "user10", "user11", "user12", "user13", "user14"]
    },
    {
      leader: "Otagotagu",
      teamName: "Ocean Riders",
      teamSlogan: "Ride the waves of destiny!",
      members: ["Otagotagu", "user15", "user16", "user17"]
    }
  ];
  
  // Create rebels with specified leader
  gameState.rebels = {
    leaders: ["PillTheBomb"],
    members: ["user18", "user19", "user20"]
  };
  
  // Save team data with colors
  saveTeamData();
  
  // Emit updated game state to all clients
  io.emit("gameState", gameState);
}

// Serve frontend files
app.use(express.static("public"));

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});