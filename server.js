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
  phase: "idle", // idle, applications, selection, voting, results
  candidates: [],
  selectedCandidates: [],
  votes: {},
  teams: [],
  rebels: {
    leaders: [],
    members: []
  },
  timerEndTime: 0
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
      processApplicationCommand(username, message);
    } 
    else if (gameState.phase === "voting" && message.startsWith("!vote ")) {
      processVoteCommand(username, message);
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
    
    // Check if user already applied
    const existingCandidate = gameState.candidates.find(c => c.username === username);
    
    if (existingCandidate) {
      // Update the existing application
      existingCandidate.teamName = teamName;
      existingCandidate.teamSlogan = teamSlogan;
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
  // Extract vote from message format: !vote <Candidate Username>
  const parts = message.split(" ");
  
  if (parts.length >= 2) {
    const voteFor = parts[1];
    
    // Check if the voted for candidate exists in our selected candidates
    const candidateExists = gameState.selectedCandidates.some(c => c.username.toLowerCase() === voteFor.toLowerCase());
    
    if (candidateExists) {
      // Record the vote
      gameState.votes[username] = voteFor.toLowerCase();
      
      // Emit updated votes
      io.emit("updateVotes", gameState.votes);
    }
  }
}

// Start listening to Twitch chat
client.connect();

// Socket.io event listeners
io.on("connection", (socket) => {
  // Send current game state to new connections
  socket.emit("gameState", gameState);
  
  // Handle game control events from the frontend
  socket.on("startApplications", () => {
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
      timerEndTime: Date.now() + 30000 // 30 seconds
    };
    
    io.emit("gameState", gameState);
    
    // End applications after 30 seconds
    setTimeout(() => {
      endApplicationsPhase();
    }, 30000);
  });
  
  socket.on("startElection", () => {
    // Start the voting phase
    gameState.phase = "voting";
    gameState.timerEndTime = Date.now() + 30000; // 30 seconds
    
    io.emit("gameState", gameState);
    
    // End voting after 30 seconds
    setTimeout(() => {
      endVotingPhase();
    }, 30000);
  });
});

// End applications phase and select random candidates
function endApplicationsPhase() {
  gameState.phase = "selection";
  
  // Select 10 random candidates
  const shuffled = [...gameState.candidates].sort(() => 0.5 - Math.random());
  gameState.selectedCandidates = shuffled.slice(0, Math.min(10, shuffled.length));
  
  io.emit("gameState", gameState);
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
  
  // Form teams
  gameState.teams = teamLeaders.map(leader => {
    // Find all users who voted for this leader
    const teamMembers = Object.entries(gameState.votes)
      .filter(([voter, vote]) => vote.toLowerCase() === leader.username.toLowerCase())
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
  
  // Add all voters for rejected candidates to rebels
  const rebelVoters = Object.entries(gameState.votes)
    .filter(([voter, vote]) => rejectedLeaders.some(leader => 
      leader.username.toLowerCase() === vote.toLowerCase()
    ))
    .map(([voter]) => voter);
  
  gameState.rebels.members = rebelVoters;
  
  io.emit("gameState", gameState);
}

// Serve frontend files
app.use(express.static("public"));

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});